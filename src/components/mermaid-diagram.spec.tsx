// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — MermaidDiagram 全口径 100%。
 * IntersectionObserver 与 mermaid 动态 import 均 vi.mock（可控回调），
 * 参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@/test-helpers/component-test-utils"
import { MermaidDiagram, unwrapMermaidPre } from "./mermaid-diagram"

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _code: string) => ({ svg: "<svg>ok</svg>" })),
}))

vi.mock("mermaid", () => ({
  default: {
    initialize: mocks.initialize,
    render: mocks.render,
  },
}))

// ── controllable IntersectionObserver ─────────────────────────────────────────

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void
let observerCallbacks: Array<(isIntersecting: boolean) => void> = []

class MockIntersectionObserver {
  constructor(cb: ObserverCallback) {
    observerCallbacks.push((isIntersecting: boolean) => cb([{ isIntersecting }]))
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function triggerIntersect(isIntersecting: boolean): void {
  const cb = observerCallbacks[observerCallbacks.length - 1]
  if (!cb) throw new Error("no observer registered")
  act(() => cb(isIntersecting))
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderDiagram(code = "graph TD; A-->B"): ReturnType<typeof render> {
  return render(<MermaidDiagram code={code} />)
}

afterEach(() => {
  cleanup()
  observerCallbacks = []
  vi.clearAllMocks()
})

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver
  mocks.initialize.mockClear()
  mocks.render.mockClear()
  mocks.render.mockResolvedValue({ svg: "<svg>ok</svg>" })
})

describe("MermaidDiagram", () => {
  it("未进入视口时渲染占位符并注册 observer", () => {
    renderDiagram()
    expect(screen.getByText("Diagram")).toBeInTheDocument()
    expect(observerCallbacks.length).toBe(1)
    expect(globalThis.IntersectionObserver).toBe(MockIntersectionObserver)
  })

  it("进入视口（isIntersecting=true）→ 渲染 mermaid svg + 缩放按钮", async () => {
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
    expect(mocks.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
    })
    expect(mocks.render).toHaveBeenCalledTimes(1)
    // svg 经 dangerouslySetInnerHTML 注入
    const svgHost = document.querySelector('[class*="cursor-zoom-in"]')
    expect(svgHost?.innerHTML).toContain("<svg>ok</svg>")
  })

  it("isIntersecting=false 时不进入渲染（observer 不触发 visible）", async () => {
    renderDiagram()
    triggerIntersect(false)
    await settle()
    expect(screen.getByText("Diagram")).toBeInTheDocument()
    expect(mocks.render).not.toHaveBeenCalled()
    // 随后 true 才渲染
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
  })

  it("渲染失败（Error）→ 错误面板展示 message", async () => {
    mocks.render.mockRejectedValueOnce(new Error("syntax boom"))
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByText("Mermaid syntax error")).toBeInTheDocument()
    })
    expect(screen.getByText("syntax boom")).toBeInTheDocument()
  })

  it("错误状态下 code 变化 → observer effect 因无容器 ref 提前返回", async () => {
    mocks.render.mockRejectedValueOnce(new Error("syntax boom"))
    const { rerender } = renderDiagram("graph TD; A-->B")
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByText("Mermaid syntax error")).toBeInTheDocument()
    })
    // 错误分支不渲染 containerRef div；code 变化重新触发 observer effect，el 为 null
    rerender(<MermaidDiagram code="graph TD; C-->D" />)
    expect(screen.getByText("Mermaid syntax error")).toBeInTheDocument()
  })

  it("渲染失败（非 Error）→ String(err) 展示", async () => {
    mocks.render.mockRejectedValueOnce("plain-fail")
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByText("plain-fail")).toBeInTheDocument()
    })
  })

  it("渲染挂起期间卸载 → cancelled 阻止 setState（成功路径假分支）", async () => {
    let resolveRender!: (v: { svg: string }) => void
    mocks.render.mockReturnValueOnce(new Promise((res) => { resolveRender = res }))
    const { unmount } = renderDiagram()
    triggerIntersect(true)
    await settle()
    // 卸载后 resolve → cancelled=true → 不写 state
    unmount()
    resolveRender({ svg: "<svg>late</svg>" })
    await settle()
  })

  it("渲染挂起期间 code 变化 → 旧 render 被取消（错误路径假分支）", async () => {
    let rejectRender!: (e: Error) => void
    mocks.render.mockReturnValueOnce(new Promise((_, rej) => { rejectRender = rej }))
    const { rerender } = renderDiagram()
    triggerIntersect(true)
    await settle()
    // code 变化 → effect 重跑 → 旧 render 取消
    rerender(<MermaidDiagram code="graph TD; B-->C" />)
    triggerIntersect(true)
    await settle()
    rejectRender(new Error("late-fail"))
    await settle()
    // 新 render 成功 → 显示 svg
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
  })

  it("estimatedHeight 随行数变化（min 80）", async () => {
    const { container } = renderDiagram("line1\nline2\nline3\nline4\nline5")
    const wrapper = container.firstChild as HTMLElement
    // 5 行 * 20 = 100
    expect(wrapper.style.minHeight).toBe("100px")
  })

  it("estimatedHeight 低于 80 时取 80", async () => {
    const { container } = renderDiagram("one")
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.style.minHeight).toBe("80px")
  })

  it("展开浮层：点击 svg 主体也可展开，放大/缩小/百分比显示/背景点击关闭", async () => {
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
    // 点击 svg 主体（cursor-zoom-in div）展开
    const svgHost = document.querySelector('[class*="cursor-zoom-in"]') as HTMLElement
    fireEvent.click(svgHost)
    expect(screen.getByText("100%")).toBeInTheDocument()

    // + 放大
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    expect(screen.getByText("130%")).toBeInTheDocument()
    // 连续放大至上限 5
    for (let i = 0; i < 15; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "+" }))
    }
    expect(screen.getByText("500%")).toBeInTheDocument()

    // − 缩小（含下限 0.3）
    fireEvent.click(screen.getByRole("button", { name: "−" }))
    expect(screen.getByText("470%")).toBeInTheDocument()
    for (let i = 0; i < 15; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "−" }))
    }
    expect(screen.getByText("30%")).toBeInTheDocument()

    // 点击背景关闭并重置 scale
    fireEvent.click(document.querySelector('[class*="fixed inset-0 z-50"]') as HTMLElement)
    expect(screen.queryByText("100%")).not.toBeInTheDocument()
  })

  it("浮层内点击 stopPropagation 不关闭", async () => {
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTitle("Enlarge diagram"))
    const inner = document.querySelector('[class*="relative h-[90vh]"]') as HTMLElement
    fireEvent.click(inner)
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("Escape 键关闭浮层并重置 scale；其他键不关闭（key 假分支）", async () => {
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTitle("Enlarge diagram"))
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    expect(screen.getByText("130%")).toBeInTheDocument()

    // 非 Escape 键不关闭
    fireEvent.keyDown(window, { key: "Enter" })
    expect(screen.getByText("130%")).toBeInTheDocument()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByText("130%")).not.toBeInTheDocument()
    // 重新展开 scale 已重置为 1
    fireEvent.click(screen.getByTitle("Enlarge diagram"))
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("X 按钮关闭浮层", async () => {
    renderDiagram()
    triggerIntersect(true)
    await waitFor(() => {
      expect(screen.getByTitle("Enlarge diagram")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTitle("Enlarge diagram"))
    const closeBtn = document.querySelector('button[class*="rounded-md p-1"]') as HTMLElement
    fireEvent.click(closeBtn)
    expect(screen.queryByText("100%")).not.toBeInTheDocument()
  })
})

describe("unwrapMermaidPre", () => {
  it("非单子节点 → null", () => {
    expect(unwrapMermaidPre(null)).toBeNull()
    expect(unwrapMermaidPre([])).toBeNull()
    expect(unwrapMermaidPre([<div key="a" />, <div key="b" />])).toBeNull()
  })

  it("单字符串子节点 → null", () => {
    expect(unwrapMermaidPre("text")).toBeNull()
  })

  it("单非 MermaidDiagram 元素 → null", () => {
    expect(unwrapMermaidPre(<div>hi</div>)).toBeNull()
  })

  it("单 MermaidDiagram 元素 → 返回该元素", () => {
    const child = <MermaidDiagram code="graph TD; A" />
    const result = unwrapMermaidPre(child)
    expect(result).not.toBeNull()
    expect((result as React.ReactElement).type).toBe(MermaidDiagram)
  })
})
