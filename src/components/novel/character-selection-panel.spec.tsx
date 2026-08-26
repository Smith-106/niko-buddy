// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, it, expect, vi } from "vitest"
import { CharacterSelectionPanel } from "./character-selection-panel"
import type { RecognizedCharacter } from "@/lib/novel/book-analysis/types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 等待 microtask 清空（@base-ui/react 的 Dialog 是异步打开的）
async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("CharacterSelectionPanel", () => {
  const characters: RecognizedCharacter[] = [
    { id: "1", name: "许七安", aliases: [], appearances: 5, chapterIndices: [0, 1, 2], importanceScore: 95, category: "主角", sourceBook: "test" },
    { id: "2", name: "临安公主", aliases: [], appearances: 3, chapterIndices: [0, 1], importanceScore: 60, category: "配角", sourceBook: "test" },
    { id: "3", name: "路人甲", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 20, category: "次要", sourceBook: "test" },
  ]

  function renderPanel(
    props: Parameters<typeof CharacterSelectionPanel>[0]
  ): { container: HTMLDivElement; cleanup: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<CharacterSelectionPanel {...props} />)
    })
    return {
      container,
      cleanup: () => {
        act(() => root.unmount())
        document.body.removeChild(container)
      },
    }
  }

  function getAllBodyHtml(): string {
    return document.body.innerHTML
  }

  it("渲染所有识别出的角色", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const html = getAllBodyHtml()
    expect(html).toContain("许七安")
    expect(html).toContain("临安公主")
    expect(html).toContain("路人甲")
    cleanup()
  })

  it("标题显示识别出 N 个角色", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    expect(getAllBodyHtml()).toContain("识别出 3 个角色")
    cleanup()
  })

  it("未选时两个提取按钮显示 0 个角色", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    expect(getAllBodyHtml()).toContain("0 个角色")
    cleanup()
  })

  it("已选 1 个时按钮显示 1 个角色", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: ["1"],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    expect(getAllBodyHtml()).toContain("1 个角色")
    cleanup()
  })

  it("包含全选主角配角按钮", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    expect(getAllBodyHtml()).toContain("全选主角配角")
    cleanup()
  })

  it("包含深度和简单提取两个按钮", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: ["1"],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const html = getAllBodyHtml()
    expect(html).toContain("深度 6 维提取")
    expect(html).toContain("简单提取")
    cleanup()
  })

  it("点击全选主角配角回调被调用", async () => {
    const onSelectAllMain = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain,
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const btn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("全选主角配角")
    ) as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => {
      btn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onSelectAllMain).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("搜索过滤角色：命中显示、无命中显示空态", async () => {
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const input = document.body.querySelector(
      'input[placeholder="搜索角色名"]'
    ) as HTMLInputElement
    expect(input).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!
    await act(async () => {
      setter.call(input, "临安")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await flushAsync()
    const html = getAllBodyHtml()
    expect(html).toContain("临安公主")
    expect(html).not.toContain("许七安")
    await act(async () => {
      setter.call(input, "查无此人")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await flushAsync()
    expect(getAllBodyHtml()).toContain("无匹配角色")
    cleanup()
  })

  it("切换排序为按出场次数", async () => {
    const sorted: RecognizedCharacter[] = [
      {
        id: "a",
        name: "高出场低重要",
        aliases: [],
        appearances: 9,
        chapterIndices: [0],
        importanceScore: 10,
        category: "次要",
        sourceBook: "test",
      },
      {
        id: "b",
        name: "低出场高重要",
        aliases: [],
        appearances: 1,
        chapterIndices: [0],
        importanceScore: 90,
        category: "主角",
        sourceBook: "test",
      },
    ]
    const { cleanup } = renderPanel({
      characters: sorted,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const rows = () =>
      Array.from(
        document.body.querySelectorAll("[data-testid^='character-row-']")
      ).map((el) => el.getAttribute("data-testid"))
    expect(rows()).toEqual(["character-row-b", "character-row-a"])
    const select = document.body.querySelector("select") as HTMLSelectElement
    expect(select).toBeTruthy()
    await act(async () => {
      select.value = "appearances"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flushAsync()
    expect(rows()).toEqual(["character-row-a", "character-row-b"])
    cleanup()
  })

  it("点击角色行触发 onToggle", async () => {
    const onToggle = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle,
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const row = document.body.querySelector(
      '[data-testid="character-row-1"]'
    ) as HTMLElement
    expect(row).toBeTruthy()
    await act(async () => {
      row.click()
    })
    expect(onToggle).toHaveBeenCalledWith("1")
    cleanup()
  })

  it("点击 checkbox 触发 onToggle 且不冒泡到行", async () => {
    const onToggle = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle,
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
    })
    await flushAsync()
    const cb = document.body.querySelector(
      '[data-testid="character-row-1"] input[type="checkbox"]'
    ) as HTMLInputElement
    expect(cb).toBeTruthy()
    await act(async () => {
      cb.click()
    })
    expect(onToggle).toHaveBeenCalledWith("1")
    expect(onToggle).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("无 onClose 时关闭 X 回退到 onCancel", async () => {
    const onCancel = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel,
    })
    await flushAsync()
    const close = document.body.querySelector(
      '[data-slot="dialog-close"]'
    ) as HTMLElement
    expect(close).toBeTruthy()
    await act(async () => {
      close.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onCancel).toHaveBeenCalled()
    cleanup()
  })

  it("提供 onClose 时关闭 X 调用 onClose 而非 onCancel", async () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel,
      onClose,
    })
    await flushAsync()
    const close = document.body.querySelector(
      '[data-slot="dialog-close"]'
    ) as HTMLElement
    expect(close).toBeTruthy()
    await act(async () => {
      close.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onClose).toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    cleanup()
  })

  it("UAT C7-2 escapeSuppressRef 置位时 Esc 不关闭弹窗（同次派发已消费）", async () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    const suppressRef = { current: true }
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel,
      onClose,
      escapeSuppressRef: suppressRef,
      nonModal: true,
    })
    await flushAsync()
    expect(
      document.body.querySelector('[data-slot="dialog-close"]')
    ).toBeTruthy()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    // 工作台 Esc 关闭后：抑制标志消费一次，本次 Esc 不关闭弹窗
    expect(onClose).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(suppressRef.current).toBe(false)
    expect(
      document.body.querySelector('[data-slot="dialog-close"]')
    ).toBeTruthy()
    cleanup()
  })

  it("UAT C7-2 反向：escape-key 关闭时 onEscapedDismiss 被调用（面板防级联）", async () => {
    const onClose = vi.fn()
    const onEscapedDismiss = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
      onClose,
      onEscapedDismiss,
    })
    await flushAsync()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    // escape-key 关闭：弹窗正常关闭且通知父层面板抑制级联
    expect(onClose).toHaveBeenCalled()
    expect(onEscapedDismiss).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("UAT C7-2 默认（无抑制 ref）Esc 仍关闭弹窗", async () => {
    const onClose = vi.fn()
    const { cleanup } = renderPanel({
      characters,
      selectedIds: [],
      onToggle: vi.fn(),
      onSelectAllMain: vi.fn(),
      onClear: vi.fn(),
      onDeepExtract: vi.fn(),
      onSimpleExtract: vi.fn(),
      onCancel: vi.fn(),
      onClose,
    })
    await flushAsync()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onClose).toHaveBeenCalled()
    cleanup()
  })
})
