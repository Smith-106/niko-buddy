// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/layout/chapter-empty-state.tsx — 第一小时：
// 无章节空态必须给可点的新建入口（经 store nonce 直连，不经 Props 回调）。

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ChapterEmptyState } from "./chapter-empty-state"

const requestChapterCreate = vi.fn()

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { requestChapterCreate: () => void }) => unknown) =>
    selector({ requestChapterCreate }),
}))

afterEach(() => {
  cleanup()
  requestChapterCreate.mockClear()
})

describe("ChapterEmptyState", () => {
  it("无章节时渲染可点新建按钮，点击走 store nonce", () => {
    const onSelect = vi.fn()
    render(<ChapterEmptyState recentChapters={[]} onSelectChapter={onSelect} />)
    const button = screen.getByTestId("preview-empty-create")
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(requestChapterCreate).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
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
