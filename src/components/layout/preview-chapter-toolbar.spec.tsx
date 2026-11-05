// @vitest-environment jsdom
//
// ChapterToolbarHeader（preview-chapter-toolbar.tsx）—— 紧凑工具条「更多」菜单的
// 批量消AI / 解包大纲两项行为补测（覆盖率战役第十三批 statements）。
//
// 这两项此前只有 preview-panel 全量渲染路径，紧凑+菜单展开且 hasProject 的组合
// 从未被触发，故其 onClick 体（onCloseMoreMenu + 动作回调）与 batchRunning 文案
// 分支、hasProject 假支均无覆盖。这里以纯展示组件的 props 直驱，断言「点击 =
// 关菜单 + 派发动作」这一可观察顺序契约。

import { describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { createRef } from "react"
import { afterEach } from "vitest"
import { buildChapterEditorHeader } from "@/lib/chapter-editor-header"
import { ChapterToolbarHeader, type ChapterToolbarHeaderProps } from "./preview-chapter-toolbar"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/inspector/inspector-panel", () => ({
  InspectorPanel: () => null,
}))

afterEach(() => cleanup())

function makeProps(overrides: Partial<ChapterToolbarHeaderProps> = {}): ChapterToolbarHeaderProps {
  return {
    toolbarRef: createRef<HTMLDivElement>(),
    titleMeasureRef: createRef<HTMLSpanElement>(),
    chapterHeader: buildChapterEditorHeader("# 第一章\n\n正文内容"),
    chapterTitleDraft: "第一章",
    chapterDisplayTitle: "第一章",
    chapterTitleMeasureText: "第一章",
    chapterTitleWidthPx: 120,
    chapterToolbarCompact: false,
    chapterMeta: null,
    hasChapterToolbarActions: true,
    chapterToolbarMoreOpen: false,
    onToggleMoreOpen: vi.fn(),
    onCloseMoreMenu: vi.fn(),
    chatExpanded: false,
    onToggleChat: vi.fn(),
    deAiProcessing: false,
    onDeAiProcess: vi.fn(),
    hasProject: true,
    batchRunning: false,
    onDeAiBatchStart: vi.fn(),
    canIngestOutline: true,
    onIngestOutline: vi.fn(),
    isOutlineIngesting: false,
    outlineIngested: false,
    onOpenUnpackOutline: vi.fn(),
    outlineSnapshotNumber: null,
    onShowOutlineSnapshot: vi.fn(),
    canSaveAsFinal: false,
    alreadyFinal: false,
    onSaveAsFinal: vi.fn(),
    onReingest: vi.fn(),
    isFinalChapterSaving: false,
    canFormatWriting: false,
    onFormatWriting: vi.fn(),
    canViewSnapshot: false,
    onShowSnapshot: vi.fn(),
    novelMode: false,
    onShowCognition: vi.fn(),
    onShowPersona: vi.fn(),
    onClosePreview: vi.fn(),
    onTitleFocus: vi.fn(),
    onTitleChange: vi.fn(),
    onTitleCommit: vi.fn(),
    onTitleCancel: vi.fn(),
    visibleSaveStatus: "",
    selectionActionPending: false,
    onCancelSelectionAction: vi.fn(),
    showInspector: false,
    inspectorProjectPath: "",
    inspectorChapterId: "",
    inspectorRefreshKey: "",
    ...overrides,
  }
}

function compactMenuProps(overrides: Partial<ChapterToolbarHeaderProps> = {}) {
  return makeProps({
    chapterToolbarCompact: true,
    chapterToolbarMoreOpen: true,
    ...overrides,
  })
}

function findMenuButtonByLabel(label: string): HTMLButtonElement {
  const button = screen
    .getAllByRole("button")
    .find((candidate) => candidate.getAttribute("aria-label") === label)
  if (!button) throw new Error(`menu button not found: ${label}`)
  return button as HTMLButtonElement
}

describe("ChapterToolbarHeader — 紧凑「更多」菜单", () => {
  it("点击批量消AI → 先关菜单再派发批量动作", () => {
    const props = compactMenuProps()
    render(<ChapterToolbarHeader {...props} />)

    fireEvent.click(findMenuButtonByLabel("preview.deAiBatch"))

    expect(props.onCloseMoreMenu).toHaveBeenCalledTimes(1)
    expect(props.onDeAiBatchStart).toHaveBeenCalledTimes(1)
  })

  it("点击解包大纲 → 先关菜单再派发解包动作", () => {
    const props = compactMenuProps()
    render(<ChapterToolbarHeader {...props} />)

    fireEvent.click(screen.getByText("preview.unpackOutline"))

    expect(props.onCloseMoreMenu).toHaveBeenCalledTimes(1)
    expect(props.onOpenUnpackOutline).toHaveBeenCalledTimes(1)
  })

  it("批量运行中：菜单项换成运行中文案并被禁用", () => {
    const props = compactMenuProps({ batchRunning: true })
    render(<ChapterToolbarHeader {...props} />)

    const button = findMenuButtonByLabel("preview.deAiBatchRunning")
    expect(button).toBeDisabled()
    expect(button.textContent).toBe("preview.deAiBatchRunning")

    fireEvent.click(button)
    // 禁用态点击不派发（不重复起跑）
    expect(props.onDeAiBatchStart).not.toHaveBeenCalled()
  })

  it("无项目：菜单不渲染批量消AI项，但其余项仍在", () => {
    const props = compactMenuProps({ hasProject: false })
    render(<ChapterToolbarHeader {...props} />)

    expect(screen.queryByText("preview.deAiBatch")).toBeNull()
    expect(screen.queryByText("preview.deAiBatchRunning")).toBeNull()
    expect(screen.getByText("preview.unpackOutline")).toBeInTheDocument()
  })
})
