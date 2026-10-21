// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/layout/chapter-empty-state.tsx — 第一小时：
// 无章节空态必须给可点的新建入口（有 onCreateChapter 时渲染按钮，无时保底文案）。

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ChapterEmptyState } from "./chapter-empty-state"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

afterEach(() => {
  cleanup()
})

describe("ChapterEmptyState", () => {
  it("无章节且有 onCreateChapter 时渲染可点新建按钮", () => {
    const onCreate = vi.fn()
    const onSelect = vi.fn()
    render(
      <ChapterEmptyState recentChapters={[]} onSelectChapter={onSelect} onCreateChapter={onCreate} />,
    )
    const button = screen.getByTestId("preview-empty-create")
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("无 onCreateChapter 时保底纯文案不崩", () => {
    render(<ChapterEmptyState recentChapters={[]} onSelectChapter={() => {}} />)
    expect(screen.queryByTestId("preview-empty-create")).toBeNull()
  })

  it("有最近章节时渲染快捷入口", () => {
    const onSelect = vi.fn()
    render(
      <ChapterEmptyState
        recentChapters={[{ path: "/p/wiki/chapters/第1章.md", label: "第1章" }]}
        onSelectChapter={onSelect}
      />,
    )
    expect(screen.getByTestId("preview-empty-recent")).toBeTruthy()
  })
})
