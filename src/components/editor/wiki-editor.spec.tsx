// @vitest-environment jsdom

import { act, useState } from "react"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { formatChapterWriting } from "@/lib/chapter-formatting"
import { WikiEditor } from "./wiki-editor"
import type { ChapterSelectionAction } from "@/lib/chapter-selection"
import type { PendingEditorHighlight } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => {
  const markdownUpdated = vi.fn()
  const mockCtx = {
    set: vi.fn(),
    get: vi.fn(() => ({ markdownUpdated })),
  }
  const editor = {
    make: vi.fn(() => editor),
    config: vi.fn((cb: unknown) => {
      if (typeof cb === "function") {
        ;(cb as (ctx: unknown) => void)(mockCtx)
      }
      return editor
    }),
    use: vi.fn(() => editor),
  }
  return { editor, mockCtx, markdownUpdated }
})

vi.mock("@milkdown/kit/core", () => ({
  Editor: mocks.editor,
  rootCtx: { token: "rootCtx" },
  defaultValueCtx: { token: "defaultValueCtx" },
}))

vi.mock("@milkdown/kit/preset/commonmark", () => ({ commonmark: vi.fn() }))
vi.mock("@milkdown/kit/preset/gfm", () => ({ gfm: vi.fn() }))
vi.mock("@milkdown/kit/plugin/history", () => ({ history: vi.fn() }))
vi.mock("@milkdown/kit/plugin/listener", () => ({
  listener: vi.fn(),
  listenerCtx: { token: "listenerCtx" },
}))
vi.mock("@milkdown/plugin-math", () => ({ math: vi.fn() }))
vi.mock("@milkdown/theme-nord", () => ({ nord: vi.fn() }))

vi.mock("@milkdown/react", async () => {
  const React = await import("react")
  return {
    MilkdownProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Milkdown: () => React.createElement("div", { "data-testid": "milkdown-root" }),
    useEditor: (factory: (root: HTMLElement) => unknown) => {
      React.useEffect(() => {
        factory(document.createElement("div"))
      }, [])
      return { status: "created" }
    },
  }
})

vi.mock("@/components/editor/frontmatter-panel", () => ({
  FrontmatterPanel: () => <div data-testid="frontmatter-panel" />,
}))

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="wiki-reader">{body}</div>,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector({ project: null }),
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

function queryTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector("textarea")
  if (!el) throw new Error("textarea not found")
  return el as HTMLTextAreaElement
}

function ControlledEditor({
  content: initial,
  onSave,
  onSelectionAction,
  highlightRequest,
  onHighlightHandled,
  normalize = true,
}: {
  content: string
  onSave?: (md: string) => void
  onSelectionAction?: (action: ChapterSelectionAction, selection: { start: number; end: number; text: string; bodySnapshot: string }) => void
  highlightRequest?: PendingEditorHighlight | null
  onHighlightHandled?: () => void
  normalize?: boolean
}) {
  const [content, setContent] = useState(initial)
  return (
    <WikiEditor
      content={content}
      onSave={(md) => {
        onSave?.(md)
        setContent(normalize ? formatChapterWriting(md) : md)
      }}
      immersiveWriting
      onSelectionAction={onSelectionAction}
      highlightRequest={highlightRequest}
      onHighlightHandled={onHighlightHandled}
    />
  )
}

describe("WikiEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  // ── 模式切换与主渲染 ──

  it("默认 read 模式渲染 WikiReader，无 frontmatter 不渲染 FrontmatterPanel", () => {
    render(<WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} />)
    expect(screen.getByTestId("wiki-reader").textContent).toBe("# 第1章\n\n正文")
    expect(screen.queryByTestId("frontmatter-panel")).toBeNull()
    expect(screen.getByTitle("Edit (raw markdown)")).toBeTruthy()
  })

  it("read 模式含 frontmatter 时渲染 FrontmatterPanel", () => {
    render(<WikiEditor content={"---\ntitle: T\n---\n\n正文"} onSave={() => {}} />)
    expect(screen.getByTestId("frontmatter-panel")).toBeTruthy()
    expect(screen.getByTestId("wiki-reader").textContent).toContain("正文")
  })

  it("read↔edit 切换按钮切换模式与图标", () => {
    const { container } = render(<WikiEditor content={"正文"} onSave={() => {}} />)
    expect(container.querySelector(".lucide-pencil")).toBeTruthy()

    fireEvent.click(screen.getByTitle("Edit (raw markdown)"))
    expect(container.querySelector(".lucide-eye")).toBeTruthy()
    expect(screen.getByText("Done")).toBeTruthy()
    expect(screen.getByTestId("milkdown-root")).toBeTruthy()

    fireEvent.click(screen.getByTitle("Done editing"))
    expect(container.querySelector(".lucide-pencil")).toBeTruthy()
    expect(screen.getByTestId("wiki-reader")).toBeTruthy()
  })

  it("defaultMode=edit 直接进入编辑模式", () => {
    render(<WikiEditor content={"正文"} onSave={() => {}} defaultMode="edit" />)
    expect(screen.getByTestId("milkdown-root")).toBeTruthy()
  })

  it("defaultMode 变化时同步模式", () => {
    const { rerender } = render(<WikiEditor content={"正文"} onSave={() => {}} defaultMode="read" />)
    expect(screen.getByTestId("wiki-reader")).toBeTruthy()
    rerender(<WikiEditor content={"正文"} onSave={() => {}} defaultMode="edit" />)
    expect(screen.getByTestId("milkdown-root")).toBeTruthy()
    rerender(<WikiEditor content={"正文"} onSave={() => {}} defaultMode="read" />)
    expect(screen.getByTestId("wiki-reader")).toBeTruthy()
  })

  it("编辑模式（非沉浸）传递 rawBlock + body 给 Milkdown，保存时拼回 rawBlock", async () => {
    const onSave = vi.fn()
    render(<WikiEditor content={"---\ntitle: T\n---\n\n正文"} onSave={onSave} defaultMode="edit" />)
    await flushAsync()

    // useEditor factory 把 default 内容写入 ctx（wrapBareMathBlocks 处理后的 body）
    expect(mocks.mockCtx.set).toHaveBeenCalledWith(
      expect.objectContaining({ token: "defaultValueCtx" }),
      "正文",
    )

    // 首次 emit 被吞，后续 emit 触发 onSave(rawBlock + markdown)
    const handler = mocks.markdownUpdated.mock.calls[mocks.markdownUpdated.mock.calls.length - 1]?.[0]
    expect(handler).toBeTypeOf("function")
    await act(async () => {
      handler(null, "首次")
    })
    expect(onSave).not.toHaveBeenCalled()
    await act(async () => {
      handler(null, "后续")
    })
    expect(onSave).toHaveBeenCalledWith("---\ntitle: T\n---\n\n后续")
    expect(mocks.editor.make).toHaveBeenCalled()
    expect(mocks.editor.use).toHaveBeenCalled()
  })

  it("wrapBareMathBlocks：裸 math 块被包裹，已包裹与无 math 不变", async () => {
    const bare = "\\begin{align}\nx=1\n\\end{align}"
    const { unmount } = render(<WikiEditor content={bare} onSave={() => {}} defaultMode="edit" />)
    await flushAsync()
    expect(mocks.mockCtx.set).toHaveBeenCalledWith(
      expect.objectContaining({ token: "defaultValueCtx" }),
      "$$\n\\begin{align}\nx=1\n\\end{align}\n$$",
    )
    unmount()

    const wrapped = "$$\n\\begin{align}\nx=1\n\\end{align}\n$$"
    render(<WikiEditor content={wrapped} onSave={() => {}} defaultMode="edit" />)
    await flushAsync()
    expect(mocks.mockCtx.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "defaultValueCtx" }),
      wrapped,
    )

    const plain = "普通文本"
    render(<WikiEditor content={plain} onSave={() => {}} defaultMode="edit" />)
    await flushAsync()
    expect(mocks.mockCtx.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "defaultValueCtx" }),
      plain,
    )
  })

  // ── 沉浸写作：基础编辑 ──

  it("immersive：挂载后自动聚焦并把光标移到末尾", async () => {
    const { container } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
    )
    await act(async () => {
      await nextFrame()
    })
    const textarea = queryTextarea(container)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(textarea.value.length)
  })

  it("immersive：输入触发 onSave，带标题时重建 # 标题", async () => {
    const onSave = vi.fn()
    const { container } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={onSave} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    setTextareaValue(textarea, "正文\n新行")
    await flushAsync()
    expect(onSave).toHaveBeenLastCalledWith("# 第1章\n\n正文\n新行")
  })

  it("immersive：无标题内容保存时只写 body", async () => {
    const onSave = vi.fn()
    const { container } = render(<WikiEditor content={"裸文本"} onSave={onSave} immersiveWriting />)
    const textarea = queryTextarea(container)
    setTextareaValue(textarea, "裸文本2")
    await flushAsync()
    expect(onSave).toHaveBeenLastCalledWith("裸文本2")
  })

  it("immersive：Enter 插入全角空格缩进并把光标移到其后", async () => {
    const { container } = render(
      <WikiEditor content={"# 第1章\n\n第一段"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.keyDown(textarea, { key: "Enter" })
    await act(async () => {
      await nextFrame()
    })
    expect(textarea.value).toContain("第一段\n　　")
    expect(textarea.selectionStart).toBe(textarea.value.length)
  })

  it("immersive：非 Enter 键不处理", () => {
    const onSave = vi.fn()
    const { container } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={onSave} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    const before = textarea.value
    fireEvent.keyDown(textarea, { key: "a" })
    expect(textarea.value).toBe(before)
    expect(onSave).not.toHaveBeenCalled()
  })

  // ── 内容同步 effect ──

  it("content 变化（未聚焦）时重置草稿并重新聚焦", async () => {
    const { container, rerender } = render(
      <WikiEditor content={"# 第1章\n\nA"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.blur()

    rerender(<WikiEditor content={"# 第1章\n\nB"} onSave={() => {}} immersiveWriting />)
    await act(async () => {
      await nextFrame()
    })
    expect(textarea.value).toBe("B")
    expect(document.activeElement).toBe(textarea)
  })

  it("content 变化（聚焦且草稿与归一化一致）时保留当前草稿", async () => {
    const onSave = vi.fn()
    const { container } = render(
      <ControlledEditor content={"# 第4章\n\n这个是怎么回事呢?"} onSave={onSave} />,
    )
    await act(async () => {
      await nextFrame()
    })
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)

    // Enter 插入新行 → onSave → 父组件 formatChapterWriting 归一化
    fireEvent.keyDown(textarea, { key: "Enter", bubbles: true, cancelable: true })
    await act(async () => {
      await nextFrame()
    })
    expect(onSave).toHaveBeenCalled()
    const lines = textarea.value.split("\n")
    expect(lines[lines.length - 1]).toBe("　　")
  })

  it("content 变化（聚焦、前文为空）时重置并把光标移到末尾", async () => {
    const { container, rerender } = render(
      <WikiEditor content={"# 第1章\n\n"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()

    rerender(<WikiEditor content={"# 第1章\n\nX"} onSave={() => {}} immersiveWriting />)
    await act(async () => {
      await nextFrame()
    })
    expect(textarea.value).toBe("X")
    expect(textarea.selectionStart).toBe(1)
  })

  it("content 变化（聚焦且前文非空）时重置草稿但不移动光标", async () => {
    const { container, rerender } = render(
      <WikiEditor content={"# 第1章\n\nA"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(1, 1)

    rerender(<WikiEditor content={"# 第1章\n\nZZ"} onSave={() => {}} immersiveWriting />)
    await act(async () => {
      await nextFrame()
    })
    expect(textarea.value).toBe("ZZ")
    // shouldMoveCaretToEnd=false → 只 focus 不 setSelectionRange（jsdom 光标位置不可靠，不断言）
  })

  // ── 选择与工具栏 ──

  it("refreshSelection：无 onSelectionAction 时清除选择", () => {
    const { container } = render(
      <WikiEditor content={"# 第1章\n\nABCDEF"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(0, 2)
    fireEvent.mouseUp(textarea)
    expect(screen.queryByText("AI润色")).toBeNull()
  })

  it("选中有效文本后出现工具栏，点击 AI润色/去AI味 触发动作并收起", () => {
    const onSelectionAction = vi.fn()
    const { container } = render(
      <WikiEditor
        content={"# 第1章\n\nABCDEF"}
        onSave={() => {}}
        immersiveWriting
        onSelectionAction={onSelectionAction}
      />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(0, 2)
    fireEvent.mouseUp(textarea)

    const toolbar = container.querySelector("[data-selection-toolbar='true']")
    expect(toolbar).toBeTruthy()
    const polish = screen.getByText("AI润色") as HTMLButtonElement
    const deai = screen.getByText("去AI味") as HTMLButtonElement
    // 工具栏按钮 onMouseDown 阻止默认行为（焦点保持）
    fireEvent.mouseDown(polish)
    fireEvent.mouseDown(deai)

    fireEvent.click(polish)
    expect(onSelectionAction).toHaveBeenCalledWith("polish", {
      start: 0,
      end: 2,
      text: "AB",
      bodySnapshot: "ABCDEF",
    })
    expect(screen.queryByText("AI润色")).toBeNull()

    textarea.setSelectionRange(1, 3)
    fireEvent.mouseUp(textarea)
    fireEvent.click(screen.getByText("去AI味"))
    expect(onSelectionAction).toHaveBeenCalledWith("de-ai", expect.objectContaining({ start: 1, end: 3 }))
  })

  it("highlightRequest 命中时 lineHeight 为空字符串走默认值", async () => {
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(() => ({ lineHeight: "" }) as CSSStyleDeclaration)
    const onHighlightHandled = vi.fn()
    const { container } = render(
      <ControlledEditor
        content={"# 第1章\n\n第二段正文"}
        highlightRequest={{ path: "/p/wiki/第1章.md", text: "正文", nonce: 1 }}
        onHighlightHandled={onHighlightHandled}
      />,
    )
    await act(async () => {
      await nextFrame()
    })
    expect(onHighlightHandled).toHaveBeenCalled()
    const textarea = queryTextarea(container)
    expect(textarea.selectionStart).toBe(3)
    expect(textarea.selectionEnd).toBe(5)
    getComputedStyleSpy.mockRestore()
  })

  it("选中空白文本不显示工具栏", () => {
    const { container } = render(
      <WikiEditor
        content={"# 第1章\n\nA  B"}
        onSave={() => {}}
        immersiveWriting
        onSelectionAction={vi.fn()}
      />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(2, 3) // 选中空格
    fireEvent.mouseUp(textarea)
    expect(screen.queryByText("AI润色")).toBeNull()
  })

  it("blur 后清除选择（未聚焦工具栏时）", async () => {
    const { container } = render(
      <WikiEditor
        content={"# 第1章\n\nABCDEF"}
        onSave={() => {}}
        immersiveWriting
        onSelectionAction={vi.fn()}
      />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(0, 2)
    fireEvent.mouseUp(textarea)
    expect(screen.getByText("AI润色")).toBeTruthy()

    textarea.blur()
    await flushAsync()
    expect(screen.queryByText("AI润色")).toBeNull()
  })

  it("blur 时若焦点在工具栏内则保留选择", async () => {
    const { container } = render(
      <WikiEditor
        content={"# 第1章\n\nABCDEF"}
        onSave={() => {}}
        immersiveWriting
        onSelectionAction={vi.fn()}
      />,
    )
    // 先等挂载 autoFocus rAF 完成，避免其稍后把焦点抢回 textarea
    await act(async () => {
      await nextFrame()
    })
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(0, 2)
    fireEvent.mouseUp(textarea)

    const polish = screen.getByText("AI润色") as HTMLButtonElement
    fireEvent.blur(textarea)
    polish.focus()
    await flushAsync()
    expect(screen.getByText("AI润色")).toBeTruthy()
  })

  it("存在选择时监听 scroll/resize 并重算位置", () => {
    const { container } = render(
      <WikiEditor
        content={"# 第1章\n\nABCDEF"}
        onSave={() => {}}
        immersiveWriting
        onSelectionAction={vi.fn()}
      />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    textarea.setSelectionRange(0, 2)
    fireEvent.mouseUp(textarea)
    expect(screen.getByText("AI润色")).toBeTruthy()

    document.dispatchEvent(new Event("scroll", { bubbles: true }))
    window.dispatchEvent(new Event("resize"))
    expect(screen.getByText("AI润色")).toBeTruthy()
  })

  // ── highlightRequest ──

  it("highlightRequest 命中时聚焦、滚动并回调 handled", async () => {
    const onHighlightHandled = vi.fn()
    const { container } = render(
      <ControlledEditor
        content={"# 第1章\n\n第一段第二段"}
        highlightRequest={{ path: "/p/wiki/ch1.md", text: "第二段", nonce: 1 }}
        onHighlightHandled={onHighlightHandled}
      />,
    )
    await act(async () => {
      await nextFrame()
    })
    const textarea = queryTextarea(container)
    expect(onHighlightHandled).toHaveBeenCalled()
    // body="第一段第二段"，"第二段" 从索引 3 开始
    expect(textarea.selectionStart).toBe(3)
    expect(textarea.selectionEnd).toBe(6)
    expect(document.activeElement).toBe(textarea)
  })

  it("highlightRequest 未命中时直接回调 handled", async () => {
    const onHighlightHandled = vi.fn()
    render(
      <ControlledEditor
        content={"# 第1章\n\n正文"}
        highlightRequest={{ path: "/p/wiki/ch1.md", text: "不存在", nonce: 1 }}
        onHighlightHandled={onHighlightHandled}
      />,
    )
    await flushAsync()
    expect(onHighlightHandled).toHaveBeenCalled()
  })

  it("highlightRequest 为空文本时直接回调 handled", async () => {
    const onHighlightHandled = vi.fn()
    render(
      <ControlledEditor
        content={"# 第1章\n\n正文"}
        highlightRequest={{ path: "/p/wiki/ch1.md", text: "   ", nonce: 1 }}
        onHighlightHandled={onHighlightHandled}
      />,
    )
    await flushAsync()
    expect(onHighlightHandled).toHaveBeenCalled()
  })

  it("highlightRequest 为 null 时不处理", async () => {
    const onHighlightHandled = vi.fn()
    render(<ControlledEditor content={"正文"} highlightRequest={null} onHighlightHandled={onHighlightHandled} />)
    await flushAsync()
    expect(onHighlightHandled).not.toHaveBeenCalled()
  })

  it("content 变化后立即卸载：sync rAF 中 textarea 引用为空", async () => {
    const { rerender, unmount } = render(
      <WikiEditor content={"# 第1章\n\nA"} onSave={() => {}} immersiveWriting />,
    )
    rerender(<WikiEditor content={"# 第1章\n\nB"} onSave={() => {}} immersiveWriting />)
    unmount()
    // 等 jsdom rAF（~600ms）触发：回调里 textareaRef.current 为 null → 直接 return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
  })

  // ── resize / 滚动容器 / ResizeObserver ──

  it("resize：找到外层滚动容器并恢复滚动位置", () => {
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(() => ({ overflowY: "auto" }) as CSSStyleDeclaration)
    const { container } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    expect(textarea.style.height).toBe("0px")
    getComputedStyleSpy.mockRestore()
  })

  it("无 ResizeObserver 时退回 window resize 监听并可取消帧", async () => {
    const originalRO = (globalThis as Record<string, unknown>).ResizeObserver
    delete (globalThis as Record<string, unknown>).ResizeObserver
    try {
      const { unmount } = render(
        <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
      )
      window.dispatchEvent(new Event("resize"))
      window.dispatchEvent(new Event("resize"))
      await act(async () => {
        await nextFrame()
      })
      unmount()
    } finally {
      ;(globalThis as Record<string, unknown>).ResizeObserver = originalRO
    }
  })

  it("无 ResizeObserver 时挂载后立刻卸载：清理时取消未决帧", async () => {
    const originalRO = (globalThis as Record<string, unknown>).ResizeObserver
    delete (globalThis as Record<string, unknown>).ResizeObserver
    try {
      const { unmount } = render(
        <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
      )
      // 不等 rAF 触发直接卸载 → cleanup 里 frame !== null → cancelAnimationFrame
      unmount()
    } finally {
      ;(globalThis as Record<string, unknown>).ResizeObserver = originalRO
    }
  })

  it("ResizeObserver 回调两次时取消前一帧", async () => {
    let observerCb: (() => void) | null = null
    class CapturingResizeObserver {
      constructor(cb: () => void) {
        observerCb = cb
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver)
    const { unmount } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
    )
    expect(observerCb).toBeTypeOf("function")
    await act(async () => {
      observerCb?.()
      observerCb?.()
    })
    await act(async () => {
      await nextFrame()
    })
    unmount()
  })

  it("Enter 后 unmount：resize 的 textarea 引用为空", async () => {
    const { container, unmount } = render(
      <WikiEditor content={"# 第1章\n\n正文"} onSave={() => {}} immersiveWriting />,
    )
    const textarea = queryTextarea(container)
    textarea.focus()
    fireEvent.keyDown(textarea, { key: "Enter" })
    unmount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })
})
