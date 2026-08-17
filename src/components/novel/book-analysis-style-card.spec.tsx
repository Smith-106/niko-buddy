// @vitest-environment jsdom

import type { ComponentProps } from "react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { describe, expect, it, vi } from "vitest"
import type { BookAnalysisLibraryBook } from "@/lib/novel/book-analysis/library-state"
import { BookAnalysisStyleCard } from "./book-analysis-style-card"

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}))

const book = {
  id: "book-1",
  path: "E:/Novel/book-analysis/book-1",
  metadata: {
    title: "长夜书",
    totalChapters: 3,
    totalWords: 12000,
    sourceType: "file",
    createdAt: 1,
    updatedAt: 2,
  },
  recognizedCharacters: [],
  characters: [],
  skills: [],
  styleStatus: "missing",
  boundAurasCount: 0,
  addedAuraCharacterIds: [],
} satisfies BookAnalysisLibraryBook

const profile = {
  schemaVersion: 1 as const,
  generatedAt: 1,
  sampledChapterIds: ["ch-1"],
  narrativeDensity: "推进紧凑",
  descriptionWeight: "描写克制",
  emotionRendering: "动作外显",
  sentenceStyle: "短句为主",
  rhetoricDensity: "比喻稀少",
  transitionStyle: "",
  narrativeVoice: "冷静旁观",
  dialogueStyle: "对白留白",
  thematicHabits: "结尾留钩",
  constitution: "1. 动作推进优先\n2. 环境描写克制",
  samples: ["他把灯挑亮。", "门外没有脚步声。"],
}

describe("BookAnalysisStyleCard", () => {
  it("renders the empty state and extracting state", () => {
    const onExtractStyle = vi.fn()
    const { rerender } = render(
      <BookAnalysisStyleCard
        book={book}
        extracting={false}
        onExtractStyle={onExtractStyle}
        onToggleStyle={vi.fn()}
      />,
    )

    expect(screen.getByText("尚未提取叙事文风。作品文风只约束叙事写法，不等同于角色说话方式。")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "提取文风" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "提取文风" }))
    expect(onExtractStyle).toHaveBeenCalledTimes(1)

    rerender(
      <BookAnalysisStyleCard
        book={book}
        extracting
        onExtractStyle={onExtractStyle}
        onToggleStyle={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: "提取中..." })).toBeDisabled()
  })

  it("renders an available profile, toggles enabled state, and expands details", () => {
    const onToggleStyle = vi.fn()
    const onExtractStyle = vi.fn()
    const { rerender } = render(
      <BookAnalysisStyleCard
        book={{ ...book, styleProfile: profile, styleStatus: "available" }}
        extracting={false}
        onExtractStyle={onExtractStyle}
        onToggleStyle={onToggleStyle}
      />,
    )

    expect(screen.getByRole("button", { name: "启用此文风" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "启用此文风" }))
    expect(onToggleStyle).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "查看全部维度、风格宪法与代表样本" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "查看全部维度、风格宪法与代表样本" }))
    expect(screen.getByRole("button", { name: "收起详情" })).toBeInTheDocument()
    expect(screen.getByText("风格宪法（注入生成）")).toBeInTheDocument()
    expect(screen.getByText("代表原文样本")).toBeInTheDocument()
    expect(screen.getByText("他把灯挑亮。")).toBeInTheDocument()
    expect(screen.getByText("门外没有脚步声。")).toBeInTheDocument()
    expect(screen.getByText("结尾留钩")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "收起详情" }))
    expect(screen.getByRole("button", { name: "查看全部维度、风格宪法与代表样本" })).toBeInTheDocument()

    rerender(
      <BookAnalysisStyleCard
        book={{ ...book, styleProfile: { ...profile, descriptionWeight: "" }, styleStatus: "enabled" }}
        extracting={false}
        onExtractStyle={onExtractStyle}
        onToggleStyle={onToggleStyle}
      />,
    )
    expect(screen.getByText("已启用")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "取消启用" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新提取文风" })).toBeInTheDocument()
  })
})
