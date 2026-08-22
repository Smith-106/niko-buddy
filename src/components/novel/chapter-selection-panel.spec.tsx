// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, waitFor, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { ChapterSelectionPanel } from "./chapter-selection-panel"
import type { RecognizedCharacter } from "@/lib/novel/book-analysis/types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Props = Parameters<typeof ChapterSelectionPanel>[0]

const CHAPTERS: Props["chapters"] = [
  { id: "ch-0001", title: "第一章", order: 1, wordCount: 1000, path: "E:/Novel/book/ch-0001.md" },
  { id: "ch-0002", title: "第二章", order: 2, wordCount: 1200, path: "E:/Novel/book/ch-0002.md" },
]

const CHARS: RecognizedCharacter[] = [
  { id: "c1", name: "林烬", aliases: [], appearances: 3, chapterIndices: [0, 1], importanceScore: 90, category: "主角", sourceBook: "长夜书" },
  { id: "c2", name: "苏遥", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 70, category: "配角", sourceBook: "长夜书" },
]

const mocks = vi.hoisted(() => ({
  pickerProps: null as null | Record<string, unknown>,
}))

vi.mock("./character-selection-panel", () => ({
  CharacterSelectionPanel: (props: Record<string, unknown>) => {
    mocks.pickerProps = props
    return <div data-testid="character-picker">character-picker</div>
  },
}))

function baseProps(): Props {
  return {
    chapters: CHAPTERS,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
}

function mount(overrides: Partial<Props> = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const propsRef: { current: Props } = { current: { ...baseProps(), ...overrides } }
  const renderNow = () => {
    act(() => {
      root.render(<ChapterSelectionPanel {...propsRef.current} />)
    })
  }
  renderNow()
  return {
    container,
    root,
    rerender: (o: Partial<Props>) => {
      propsRef.current = { ...baseProps(), ...o }
      renderNow()
    },
    cleanup: () => {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text))
  expect(btn).toBeTruthy()
  return btn as HTMLButtonElement
}

/** 精确匹配文本的按钮（避免「取消」匹配到「取消全选」） */
function findExactButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)
  expect(btn).toBeTruthy()
  return btn as HTMLButtonElement
}

function clickAnalyze(container: HTMLElement): HTMLButtonElement {
  const btn = findButton(container, "开始分析")
  act(() => btn.click())
  return btn
}

describe("ChapterSelectionPanel", () => {
  beforeEach(() => {
    setupDomGlobals()
    vi.clearAllMocks()
    mocks.pickerProps = null
  })

  it("基础渲染：默认全选、统计信息、章节列表、取消按钮", () => {
    const onCancel = vi.fn()
    const onAnalyzingChange = vi.fn()
    const { container, cleanup } = mount({ onCancel, onAnalyzingChange })
    // 初始全选
    expect(container.textContent).toContain("已选择：2")
    expect(container.textContent).toContain("2,200")
    expect(container.textContent).toContain("取消全选")
    expect(container.textContent).toContain("#1")
    expect(container.textContent).toContain("第一章")
    // 挂载时 onAnalyzingChange(false)
    expect(onAnalyzingChange).toHaveBeenCalledWith(false)
    // 取消按钮（底部操作栏，精确匹配避免「取消全选」）
    act(() => findExactButton(container, "取消").click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("点击章节行取消勾选再勾选，selectAll 复位", () => {
    const { container, cleanup } = mount()
    // 直接点击 checkbox：React onChange(noop) + 冒泡到 label onClick 各一次，避免
    // jsdom label 激活行为对后代点击的二次触发
    const firstCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(firstCheckbox)
    expect(container.textContent).toContain("已选择：1")
    expect(container.textContent).toContain("全选") // selectAll 复位
    fireEvent.click(firstCheckbox)
    expect(container.textContent).toContain("已选择：2")
    cleanup()
  })

  it("checkbox onChange（noop）经点击触发且不影响行选择", () => {
    const { container, cleanup } = mount()
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    expect(container.textContent).toContain("已选择：1")
    cleanup()
  })

  it("全选/取消全选切换", () => {
    const { container, cleanup } = mount()
    act(() => findButton(container, "取消全选").click())
    expect(container.textContent).toContain("已选择：0")
    expect(container.textContent).toContain("全选")
    act(() => findButton(container, "全选").click())
    expect(container.textContent).toContain("已选择：2")
    cleanup()
  })

  it("快捷选择：前10/50/100章", () => {
    const { container, cleanup } = mount()
    act(() => findButton(container, "前10章").click())
    expect(container.textContent).toContain("已选择：2")
    act(() => findButton(container, "前50章").click())
    expect(container.textContent).toContain("已选择：2")
    act(() => findButton(container, "前100章").click())
    expect(container.textContent).toContain("已选择：2")
    cleanup()
  })

  it("开始分析：onConfirm 收到选中的章节，onAnalyzingChange(true)", () => {
    const onConfirm = vi.fn()
    const onAnalyzingChange = vi.fn()
    const { container, cleanup } = mount({ onConfirm, onAnalyzingChange })
    clickAnalyze(container)
    expect(onConfirm).toHaveBeenCalledWith(["ch-0001", "ch-0002"])
    expect(onAnalyzingChange).toHaveBeenCalledWith(true)
    expect(container.textContent).toContain("分析中...")
    cleanup()
  })

  it("onConfirm 抛错：回到可点击状态并打印错误", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { container, cleanup } = mount({
      onConfirm: () => {
        throw new Error("confirm-boom")
      },
    })
    const btn = clickAnalyze(container)
    expect(errorSpy).toHaveBeenCalledWith("[开始分析] onConfirm 调用出错:", expect.any(Error))
    expect(btn.textContent).toContain("开始分析（2 章）")
    errorSpy.mockRestore()
    cleanup()
  })

  it("无章节时开始按钮禁用", () => {
    const onConfirm = vi.fn()
    const { container, cleanup } = mount({ chapters: [], onConfirm })
    const btn = findButton(container, "开始分析")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(container.textContent).toContain("已选择：0")
    // 直接对禁用按钮派发 click：!canConfirm 守卫提前 return，不触发 onConfirm
    fireEvent.click(btn)
    expect(onConfirm).not.toHaveBeenCalled()
    cleanup()
  })

  it("分析中提示条：各识别状态标签", () => {
    for (const [status, label] of [
      ["idle", "准备中"],
      ["llm_scoring", "LLM 评分中"],
      ["llm_recognizing", "AI 识别角色中（可能需要较长时间，请耐心等待）"],
      ["heuristic", "读取章节中"],
    ] as const) {
      const { container, cleanup } = mount({ recognitionStatus: status })
      clickAnalyze(container)
      expect(container.textContent).toContain(label)
      expect(container.textContent).toContain("正在分析中")
      cleanup()
    }
  })

  it("done/error 状态复位 isAnalyzing；再点击显示对应标签", () => {
    const { container, cleanup, rerender } = mount({ recognitionStatus: "heuristic" })
    clickAnalyze(container)
    expect(container.textContent).toContain("读取章节中")
    // done → 复位 isAnalyzing（分析条消失）
    rerender({ recognitionStatus: "done", recognizedCharacters: [] })
    expect(container.textContent).not.toContain("正在分析中")
    clickAnalyze(container)
    expect(container.textContent).toContain("识别完成")
    cleanup()
  })

  it("error 状态点击后显示识别失败", () => {
    const { container, cleanup } = mount({ recognitionStatus: "error" })
    clickAnalyze(container)
    expect(container.textContent).toContain("识别失败")
    cleanup()
  })

  it("分析中提示条的后台运行按钮：触发 onBackground 并隐藏", () => {
    const onBackground = vi.fn()
    const { container, cleanup } = mount({ recognitionStatus: "llm_recognizing", onBackground })
    clickAnalyze(container)
    expect(container.textContent).toContain("AI 识别角色中（可能需要较长时间，请耐心等待）")
    act(() => findButton(container, "后台运行").click())
    expect(onBackground).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain("后台运行")
    cleanup()
  })

  it("无 onBackground 时分析条后台运行不报错", () => {
    const { container, cleanup } = mount({ recognitionStatus: "heuristic" })
    clickAnalyze(container)
    act(() => findButton(container, "后台运行").click())
    expect(container.textContent).not.toContain("后台运行")
    cleanup()
  })

  it("分析中切到 extractionPhase：分析条隐藏、进度区显示", () => {
    const { container, cleanup, rerender } = mount({})
    clickAnalyze(container)
    expect(container.textContent).toContain("正在分析中")
    rerender({ extractionPhase: "deep", extractionProgress: { stageLabel: "6 维分析中", percentage: 30 } })
    expect(container.textContent).not.toContain("正在分析中")
    expect(container.textContent).toContain("深度 6 维提取中")
    cleanup()
  })

  it("提取中（deep）：标题/进度/当前项/后台运行", () => {
    const onBackground = vi.fn()
    const { container, cleanup } = mount({
      extractionPhase: "deep",
      extractionProgress: { stageLabel: "提取中...", percentage: 40, currentItem: "林烬", isCompleted: false },
      onBackground,
    })
    expect(container.textContent).toContain("深度 6 维提取中")
    expect(container.textContent).toContain("正在提取角色特征，请耐心等待")
    expect(container.textContent).toContain("提取中...")
    expect(container.textContent).toContain("林烬")
    const bar = container.querySelector('[style*="width"]') as HTMLElement
    expect(bar.style.width).toBe("40%")
    // 工具栏隐藏
    expect(container.textContent).not.toContain("开始分析")
    // 后台运行
    act(() => findButton(container, "后台运行").click())
    expect(onBackground).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain("后台运行")
    cleanup()
  })

  it("无 onBackground 时进度区后台运行不报错", () => {
    const { container, cleanup } = mount({
      extractionPhase: "deep",
      extractionProgress: { stageLabel: "提取中", isCompleted: false },
    })
    act(() => findButton(container, "后台运行").click())
    expect(container.textContent).not.toContain("后台运行")
    cleanup()
  })

  it("提取中（simple）+ 无 stageLabel 兜底", () => {
    const { container, cleanup } = mount({ extractionPhase: "simple", extractionProgress: {} })
    expect(container.textContent).toContain("简单提取中")
    expect(container.textContent).toContain("准备中...")
    const bar = container.querySelector('[style*="width"]') as HTMLElement
    expect(bar.style.width).toBe("0%")
    cleanup()
  })

  it("提取完成：提示 + 错误信息 + 关闭", () => {
    const onCancel = vi.fn()
    const { container, cleanup } = mount({
      extractionProgress: { isCompleted: true, error: "部分角色失败" },
      onCancel,
    })
    expect(container.textContent).toContain("提取完成")
    expect(container.textContent).toContain("角色特征提取已完成")
    expect(container.textContent).toContain("部分角色失败")
    act(() => findButton(container, "关闭").click())
    expect(onCancel).toHaveBeenCalled()
    cleanup()
  })

  it("提取完成（无错误信息）", () => {
    const { container, cleanup } = mount({ extractionProgress: { isCompleted: true } })
    expect(container.textContent).toContain("提取完成")
    expect(container.textContent).not.toContain("部分角色失败")
    cleanup()
  })

  it("提取错误提示（进行中 + error）", () => {
    const { container, cleanup } = mount({
      extractionPhase: "deep",
      extractionProgress: { error: "boom-error", isCompleted: false },
    })
    expect(container.textContent).toContain("boom-error")
    cleanup()
  })

  it("点击已提取角色时传出当前选中的章节", () => {
    const onLoadExtractedCharacters = vi.fn()
    const { container, cleanup } = mount({
      hasExtractedCharacters: true,
      onLoadExtractedCharacters,
    })
    act(() => findButton(container, "已提取角色").click())
    expect(onLoadExtractedCharacters).toHaveBeenCalledWith(["ch-0001", "ch-0002"])
    cleanup()
  })

  it("hasExtractedCharacters 缺失时不显示已提取角色按钮", () => {
    const { container, cleanup } = mount({})
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("已提取角色"))).toBe(false)
    cleanup()
  })

  it("角色选择弹窗：条件满足时透传全部 props 与回调", () => {
    const onToggleCharacter = vi.fn()
    const onSelectAllMain = vi.fn()
    const onClearSelection = vi.fn()
    const onDeepExtract = vi.fn()
    const onSimpleExtract = vi.fn()
    const onCharacterPickerClose = vi.fn()
    const onCancel = vi.fn()
    const { container, cleanup } = mount({
      recognitionStatus: "done",
      recognizedCharacters: CHARS,
      selectedCharacterIds: ["c1"],
      onToggleCharacter,
      onSelectAllMain,
      onClearSelection,
      onDeepExtract,
      onSimpleExtract,
      onCharacterPickerClose,
      onCancel,
    })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeTruthy()
    expect(mocks.pickerProps).toMatchObject({
      characters: CHARS,
      selectedIds: ["c1"],
      onCancel,
      onClose: onCharacterPickerClose,
    })
    const p = mocks.pickerProps as Record<string, (...args: unknown[]) => void>
    act(() => p.onToggle("c1"))
    expect(onToggleCharacter).toHaveBeenCalledWith("c1")
    act(() => p.onSelectAllMain())
    expect(onSelectAllMain).toHaveBeenCalledTimes(1)
    act(() => p.onClear())
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    act(() => p.onDeepExtract())
    expect(onDeepExtract).toHaveBeenCalledTimes(1)
    act(() => p.onSimpleExtract())
    expect(onSimpleExtract).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("角色选择弹窗条件：逐项缺失回调时不显示", () => {
    const done = { recognitionStatus: "done" as const, recognizedCharacters: [CHARS[0]] }
    const { container, cleanup, rerender } = mount(done)
    // recognizedCharacters 为空
    rerender({ recognitionStatus: "done", recognizedCharacters: [] })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    // extractionPhase 存在
    rerender({ ...done, extractionPhase: "deep" })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    // 逐个补齐回调
    rerender({ ...done, onToggleCharacter: vi.fn() })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    rerender({ ...done, onToggleCharacter: vi.fn(), onSelectAllMain: vi.fn() })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    rerender({ ...done, onToggleCharacter: vi.fn(), onSelectAllMain: vi.fn(), onClearSelection: vi.fn() })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    rerender({
      ...done,
      onToggleCharacter: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClearSelection: vi.fn(),
      onDeepExtract: vi.fn(),
    })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeNull()
    rerender({
      ...done,
      onToggleCharacter: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClearSelection: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
    })
    expect(container.querySelector('[data-testid="character-picker"]')).toBeTruthy()
    cleanup()
  })

  it("Escape 键关闭 → onCancel；非 Tab/Escape 键不触发焦点陷阱", () => {
    const onCancel = vi.fn()
    const { cleanup } = mount({ onCancel })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    // 其他按键：不关闭、不触发焦点循环
    fireEvent.keyDown(document, { key: "Enter" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("TASK-LE-5 Radix 迁移：role=dialog/aria-modal/aria-labelledby + 打开时 scroll lock", async () => {
    const { container, cleanup } = mount()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    // DialogTitle（h2）提供可访问名称
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toContain(
      "选择分析章节",
    )
    // Radix scroll lock：body 标记 data-scroll-locked（替代手写 overflow hidden）
    await waitFor(() => expect(document.body.hasAttribute("data-scroll-locked")).toBe(true))
    cleanup()
  })

  it("Tab 焦点陷阱：shift+Tab 从首元素到末元素，Tab 从末元素回首元素", () => {
    const { container, cleanup } = mount()
    const focusable = Array.from(container.querySelectorAll("button:not([disabled])")) as HTMLElement[]
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    first.focus()
    expect(document.activeElement).toBe(first)
    // shift+Tab：首元素 → 末元素（Radix FocusScope 在容器内拦截 Tab）
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
    // Tab：末元素 → 首元素
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)
    // 中间元素 + shift+Tab：不触发循环
    const middle = focusable[2]
    middle.focus()
    fireEvent.keyDown(middle, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(middle)
    cleanup()
  })

  it("Tab 键但焦点不在边界：不阻止默认行为", () => {
    const { container, cleanup } = mount()
    const focusable = Array.from(container.querySelectorAll("button:not([disabled])")) as HTMLElement[]
    const middle = focusable[2]
    middle.focus()
    const keydown = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    middle.dispatchEvent(keydown)
    expect(keydown.defaultPrevented).toBe(false)
    cleanup()
  })
})
