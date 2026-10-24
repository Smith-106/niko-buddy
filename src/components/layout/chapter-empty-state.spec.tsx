// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/layout/chapter-empty-state.tsx — 第一小时：
// 无章节空态必须给可点的新建入口（经 store nonce 直连，不经 Props 回调）。
// Odyssey：下一步行动行（新建章节 + 去看看图谱），无项目时新建隐藏只留图谱跳转。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ChapterEmptyState } from "./chapter-empty-state"

const mocks = vi.hoisted(() => ({
  project: { id: "p1", name: "demo", path: "/p" } as { id: string; name: string; path: string } | null,
  setActiveView: vi.fn(),
  requestChapterCreate: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      project: mocks.project,
      setActiveView: mocks.setActiveView,
      requestChapterCreate: mocks.requestChapterCreate,
    }),
}))

beforeEach(() => {
  mocks.project = { id: "p1", name: "demo", path: "/p" }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ChapterEmptyState", () => {
  it("无章节时渲染可点新建按钮，点击走 store nonce", () => {
    const onSelect = vi.fn()
    render(<ChapterEmptyState recentChapters={[]} onSelectChapter={onSelect} />)
    const button = screen.getByTestId("preview-empty-create")
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(mocks.requestChapterCreate).toHaveBeenCalledTimes(1)
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

  it("有项目时同时给出新建与图谱两个下一步按钮", () => {
    const onSelect = vi.fn()
    render(<ChapterEmptyState recentChapters={[]} onSelectChapter={onSelect} />)
    expect(screen.getByTestId("preview-empty-create")).toBeInTheDocument()
    expect(screen.getByTestId("preview-empty-graph")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("preview-empty-graph"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("graph")
  })

  it("有最近章节时也保留新建与图谱入口", () => {
    const onSelect = vi.fn()
    render(
      <ChapterEmptyState
        recentChapters={[{ path: "/p/wiki/chapters/第1章.md", label: "第1章" }]}
        onSelectChapter={onSelect}
      />,
    )
    expect(screen.getByTestId("preview-empty-create")).toBeInTheDocument()
    expect(screen.getByTestId("preview-empty-graph")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("preview-empty-create"))
    expect(mocks.requestChapterCreate).toHaveBeenCalledTimes(1)
  })

  it("无项目时隐藏新建（链路静默无操作），只留图谱跳转与提示", () => {
    mocks.project = null
    const onSelect = vi.fn()
    render(<ChapterEmptyState recentChapters={[]} onSelectChapter={onSelect} />)
    expect(screen.queryByTestId("preview-empty-create")).not.toBeInTheDocument()
    expect(screen.getByTestId("preview-empty-graph")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("preview-empty-graph"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("graph")
    expect(mocks.requestChapterCreate).not.toHaveBeenCalled()
  })
})
