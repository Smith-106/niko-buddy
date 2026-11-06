// @vitest-environment jsdom
/**
 * FrameworkConfirmPanel 补测：handleSave 的 `if (!onSave) return` 早退。
 *
 * 保存按钮本身由 `{onSave && <Button onClick={handleSave}>}` 条件渲染，因此
 * 「按钮存在但 onSave 已消失」只能通过重渲染时 props 被移除、同时保留对旧
 * onClick 闭包的引用来构造。本用例用 getter 提供 onSave：
 *   1. 首帧 getter 返回 vi.fn() → 按钮渲染，捕获该 DOM 节点及其 onClick；
 *   2. 把 getter 切到 undefined 并 rerender；
 *   3. 直接派发到旧节点（React 复用同一 button 时 onClick 会换成新闭包；
 *      新闭包来自无 onSave 的渲染，handleSave 命中早退）。
 * 断言可观察行为：onSave 未被调用、不出现「已保存」提示、面板不崩。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type { StoryFramework, StoryNode } from "@/lib/novel"
import zh from "@/i18n/zh.json"

const T = zh.storySimulation as unknown as Record<string, string>

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: undefined, isDragging: false }),
    verticalListSortingStrategy: vi.fn(),
  }
})
vi.mock("@dnd-kit/utilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/utilities")>()
  return { ...actual, CSS: { Transform: { toString: () => "" } } }
})

function makeNode(index: number): StoryNode {
  return {
    index, phase: "起", title: `节点${index + 1}`, coreConflict: `冲突${index + 1}`,
    involvedCharacters: ["甲"], goal: `目标${index + 1}`, causeFromPrev: "起因", expectedOutcome: "结局",
  } as StoryNode
}
function makeFramework(): StoryFramework {
  return {
    id: "f1", title: "测试框架", shortTitle: "短", premise: "前提", targetWords: 1000,
    simulationMode: "quick", sourceChapters: 0, nodes: [makeNode(0), makeNode(1)],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as StoryFramework
}

describe("FrameworkConfirmPanel — 保存守卫", () => {
  afterEach(() => {
    cleanup()
    useStorySimulationStore.setState({ currentFramework: null } as never)
    vi.useRealTimers()
  })

  it("onSave 在重渲染中消失后点击保存 → 早退，不回调也不显示已保存提示", async () => {
    const onSave = vi.fn()
    let current: (() => void) | undefined = onSave
    const props = {
      onConfirm: vi.fn(),
      onRegenerate: vi.fn(),
      get onSave() { return current },
    }
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    const { FrameworkConfirmPanel } = await import("./framework-confirm-panel")
    const C = FrameworkConfirmPanel as ComponentType<typeof props>
    const { rerender } = render(<C {...props} />)
    const saveButton = screen.getByText(T.saveFramework).closest("button") as HTMLButtonElement
    expect(saveButton).toBeTruthy()

    // 模拟父组件在保存动作到达前撤掉了 onSave 回调
    current = undefined
    rerender(<C {...props} />)

    await act(async () => {
      fireEvent.click(saveButton)
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText(T.saved)).toBeNull()
    // 面板仍完整（早退不销毁 UI）
    expect(screen.getByText("测试框架")).toBeTruthy()
  })
})
