// @vitest-environment jsdom
/**
 * 思维导图视图（mindmap-views）行为测试。
 *
 * 覆盖：折叠收起再接展开（toggle 双分支）、胶囊卡片的键盘可达性（Enter/Space 与
 * 非确认键）、无 onNodeClick / 无 collapsedIds 的只读用法，以及深色系主题下
 * 白底 tint 的反色收敛（PAT-U5/S3-4）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NODE_TYPE_COLORS, mixColor } from "@/lib/graph-style"
import type { MindMapNode } from "@/lib/graph-readable"
import { MindMapBranch, MindMapGraphView, collectMindMapParentIds } from "./mindmap-views"

const themeState = vi.hoisted(() => ({ theme: "light", systemDark: false }))

// mindmap-views 顶层 import @react-sigma/core（ZoomControls 用 useSigma）：
// 真实 sigma 包在 jsdom 下缺 WebGL2RenderingContext，必须替身。
vi.mock("@react-sigma/core", () => ({
  useSigma: () => ({
    getCamera: () => ({ animatedZoom: vi.fn(), animatedUnzoom: vi.fn(), animatedReset: vi.fn() }),
    refresh: vi.fn(),
  }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: { theme: string }) => unknown) => selector({ theme: themeState.theme }),
}))

vi.mock("@/lib/theme-utils", () => ({
  isSystemDark: () => themeState.systemDark,
}))

function leaf(id: string, label: string, nodeType?: string): MindMapNode {
  return { id, label, children: [], nodeType }
}

function tree(): MindMapNode[] {
  return [
    {
      id: "root",
      label: "全书",
      children: [leaf("c1", "第一章"), leaf("c2", "第二章")],
    },
  ]
}

describe("MindMapBranch — 只读与键盘可达", () => {
  beforeEach(() => {
    themeState.theme = "light"
    themeState.systemDark = false
  })

  afterEach(() => {
    cleanup()
  })

  it("无 onNodeClick 时胶囊不是按钮，Enter 不会触发任何回调（无 handler）", () => {
    const onNodeClick = vi.fn()
    const { container } = render(<MindMapBranch node={leaf("n1", "角色甲")} />)

    const chip = container.querySelector('[title="角色甲"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.getAttribute("role")).toBeNull()
    expect(chip.getAttribute("tabindex")).toBeNull()

    fireEvent.keyDown(chip, { key: "Enter" })
    fireEvent.keyDown(chip, { key: " " })
    expect(onNodeClick).not.toHaveBeenCalled()
  })

  it("有 onNodeClick 时 Enter/Space 触发选中并阻止默认滚动，其它键不触发", () => {
    const onNodeClick = vi.fn()
    const node = leaf("n1", "角色甲")
    const { container } = render(<MindMapBranch node={node} onNodeClick={onNodeClick} />)

    const chip = container.querySelector('[title="角色甲"]') as HTMLElement
    expect(chip.getAttribute("role")).toBe("button")
    expect(chip.getAttribute("tabindex")).toBe("0")

    const enterEvent = fireEvent.keyDown(chip, { key: "Enter" })
    expect(enterEvent).toBe(false) // preventDefault 已调用
    fireEvent.keyDown(chip, { key: " " })
    fireEvent.keyDown(chip, { key: "a" })
    expect(onNodeClick).toHaveBeenCalledTimes(2)
    expect(onNodeClick).toHaveBeenNthCalledWith(1, node)
    expect(onNodeClick).toHaveBeenNthCalledWith(2, node)

    fireEvent.click(chip)
    expect(onNodeClick).toHaveBeenCalledTimes(3)
  })

  it("未传 collapsedIds 时分支默认全展开", () => {
    render(<MindMapBranch node={tree()[0]} onNodeClick={() => {}} />)

    expect(screen.getByText("第一章")).toBeTruthy()
    expect(screen.getByText("第二章")).toBeTruthy()
    expect(screen.getByRole("button", { name: /折叠子树/ })).toBeTruthy()
  })
})

describe("MindMapBranch — 主题 tint（深色收敛）", () => {
  afterEach(() => {
    cleanup()
  })

  /** jsdom 会把内联颜色归一为 rgb()，比对前统一转换。 */
  function cssRgb(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgb(${r}, ${g}, ${b})`
  }

  function chipBackground(nodeType: string): string {
    const { container, unmount } = render(<MindMapBranch node={leaf("n1", "角色甲", nodeType)} />)
    const chip = container.querySelector('[title="角色甲"]') as HTMLElement
    const background = chip.style.backgroundColor
    unmount()
    return background
  }

  it("浅色主题保持白色 tint（零行为变化）", () => {
    themeState.theme = "light"
    expect(chipBackground("character")).toBe(cssRgb(mixColor(NODE_TYPE_COLORS.character, "#ffffff", 0.92)))
  })

  it("deep-blue 主题改用深色 tint，避免白底白字沉底", () => {
    const lightTint = (() => {
      themeState.theme = "light"
      return chipBackground("character")
    })()
    themeState.theme = "deep-blue"
    const darkTint = chipBackground("character")
    expect(darkTint).toBe(cssRgb(mixColor(NODE_TYPE_COLORS.character, "#0f172a", 0.92)))
    expect(darkTint).not.toBe(lightTint)
  })

  it("system 主题按系统深色偏好选 tint", () => {
    themeState.theme = "system"
    themeState.systemDark = true
    expect(chipBackground("character")).toBe(cssRgb(mixColor(NODE_TYPE_COLORS.character, "#0f172a", 0.92)))

    themeState.systemDark = false
    expect(chipBackground("character")).toBe(cssRgb(mixColor(NODE_TYPE_COLORS.character, "#ffffff", 0.92)))
  })

  it("无 nodeType 时不写 accent 内联样式（中性样式）", () => {
    const { container } = render(<MindMapBranch node={leaf("n1", "分组")} />)
    const chip = container.querySelector('[title="分组"]') as HTMLElement
    expect(chip.getAttribute("style")).toBeNull()
  })
})

describe("MindMapGraphView — 折叠/展开交互", () => {
  afterEach(() => {
    cleanup()
  })

  it("collectMindMapParentIds 只收有子节点的 id", () => {
    const forest: MindMapNode[] = [
      {
        id: "root",
        label: "根",
        children: [{ id: "mid", label: "中", children: [leaf("leaf1", "叶")] }],
      },
      leaf("solo", "孤立"),
    ]

    expect(collectMindMapParentIds(forest)).toEqual(["root", "mid"])
    expect(collectMindMapParentIds([])).toEqual([])
  })

  it("点击折叠按钮收起子节点，再次点击展开（toggle 双分支）", () => {
    const onNodeClick = vi.fn()
    render(<MindMapGraphView mindMap={tree()} onNodeClick={onNodeClick} />)

    expect(screen.getByText("第一章")).toBeTruthy()

    fireEvent.click(screen.getByTestId("mindmap-collapse-toggle-root"))
    expect(screen.queryByText("第一章")).toBeNull()
    expect(screen.getByTestId("mindmap-collapse-toggle-root").getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(screen.getByTestId("mindmap-collapse-toggle-root"))
    expect(screen.getByText("第一章")).toBeTruthy()
    expect(screen.getByTestId("mindmap-collapse-toggle-root").getAttribute("aria-expanded")).toBe("true")
  })

  it("工具栏全部收起后全部展开", () => {
    render(<MindMapGraphView mindMap={tree()} />)

    fireEvent.click(screen.getByText("全部收起"))
    expect(screen.queryByText("第一章")).toBeNull()

    fireEvent.click(screen.getByText("全部展开"))
    expect(screen.getByText("第一章")).toBeTruthy()
  })

  it("数据源切换时清空折叠态（旧 id 不误伤新树）", () => {
    const { rerender } = render(<MindMapGraphView mindMap={tree()} />)

    fireEvent.click(screen.getByTestId("mindmap-collapse-toggle-root"))
    expect(screen.queryByText("第一章")).toBeNull()

    rerender(<MindMapGraphView mindMap={[{ id: "other", label: "新根", children: [leaf("x1", "新叶")] }]} />)
    expect(screen.getByText("新叶")).toBeTruthy()
    expect(screen.getByTestId("mindmap-collapse-toggle-other").getAttribute("aria-expanded")).toBe("true")
  })
})
