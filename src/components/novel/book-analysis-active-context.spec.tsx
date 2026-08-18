// @vitest-environment jsdom
/**
 * BookAnalysisActiveContext — 当前 AI 会话约束侧栏（拆书库三栏布局第三栏）。
 * 纯展示组件：启用文风 + 角色绑定列表，覆盖空态/数据态/未知角色 Skill 兜底。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import type { BookAnalysisAuraBindingSummary } from "@/lib/novel/book-analysis/library-state"
import type { WritingStylePreset } from "@/lib/novel/writing-style-store"
import { BookAnalysisActiveContext } from "./book-analysis-active-context"

const profile = {
  schemaVersion: 1 as const,
  generatedAt: 1,
  sampledChapterIds: ["c1"],
  narrativeDensity: "高",
  descriptionWeight: "中",
  emotionRendering: "",
  sentenceStyle: "",
  rhetoricDensity: "",
  transitionStyle: "",
  narrativeVoice: "",
  dialogueStyle: "简洁",
  thematicHabits: "",
  constitution: "硬约束",
  samples: [],
}

const enabledStyle: WritingStylePreset = {
  id: "style-1",
  name: "凡人修仙传 · 文风",
  sourceBook: "凡人修仙传",
  profile,
  createdAt: 1,
  updatedAt: 2,
}

function renderContext(enabledStyle: WritingStylePreset | null, bindings: BookAnalysisAuraBindingSummary[]) {
  render(<BookAnalysisActiveContext enabledStyle={enabledStyle} bindings={bindings} />)
}

afterEach(() => cleanup())

describe("BookAnalysisActiveContext", () => {
  it("renders header, enabled style and bound characters", () => {
    renderContext(enabledStyle, [{ characterName: "主角", auraId: "aura-hanli", auraName: "韩立" }])
    expect(screen.getByText("当前 AI 会话约束")).toBeInTheDocument()
    expect(screen.getByText("启用文风")).toBeInTheDocument()
    expect(screen.getByText("凡人修仙传 · 文风")).toBeInTheDocument()
    expect(screen.getByText(/单选规则/)).toBeInTheDocument()
    expect(screen.getByText("角色绑定")).toBeInTheDocument()
    expect(screen.getByText("主角 → 韩立")).toBeInTheDocument()
  })

  it("renders empty states when no style and no bindings", () => {
    renderContext(null, [])
    expect(screen.getByText("当前未启用拆书文风。")).toBeInTheDocument()
    expect(screen.getByText("当前没有小说人物绑定拆书角色 Skill。")).toBeInTheDocument()
  })

  it("falls back to 未知角色 Skill when auraName is empty", () => {
    renderContext(null, [{ characterName: "反派", auraId: "aura-x", auraName: "" }])
    expect(screen.getByText("反派 → 未知角色 Skill")).toBeInTheDocument()
  })

  it("renders multiple bindings with distinct keys", () => {
    renderContext(null, [
      { characterName: "主角", auraId: "a1", auraName: "韩立" },
      { characterName: "师尊", auraId: "a2", auraName: "南宫婉" },
    ])
    expect(screen.getByText("主角 → 韩立")).toBeInTheDocument()
    expect(screen.getByText("师尊 → 南宫婉")).toBeInTheDocument()
  })
})
