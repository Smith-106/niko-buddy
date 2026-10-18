// @vitest-environment jsdom
/** 提示词注册表面板：只读枚举 + 展开预览 + 两条显式 N/A。 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PromptRegistryPanel } from "./prompt-registry-panel"
import type { PromptRegistryEntry } from "@/lib/novel"

const entries: PromptRegistryEntry[] = [
  {
    id: "chapterGeneration",
    scene: "chapter",
    declaredParams: 2,
    slotCount: 2,
    slotCountExceedsDeclared: false,
    slotProbeCapped: false,
    missingSlots: [],
    preview: "«arg1»\n\n请根据以上上下文包和大纲，撰写以下章节：\n«arg2»",
    truncated: false,
    error: null,
  },
  {
    id: "chapterBroken",
    scene: "chapter",
    declaredParams: 1,
    slotCount: 1,
    slotCountExceedsDeclared: false,
    slotProbeCapped: false,
    preview: null,
    truncated: false,
    missingSlots: [],
    error: "boom",
  },
  {
    id: "standalone",
    scene: "misc",
    declaredParams: 0,
    slotCount: 0,
    slotCountExceedsDeclared: false,
    slotProbeCapped: false,
    preview: "固定提示词",
    truncated: false,
    missingSlots: [],
    error: null,
  },
]

describe("PromptRegistryPanel", () => {
  afterEach(cleanup)

  it("按场景分组 + 头行计数齐全", () => {
    render(<PromptRegistryPanel entries={entries} />)
    expect(screen.getByTestId("prompt-registry-panel").textContent).toContain("3 条")
    expect(screen.getByTestId("prompt-registry-panel").textContent).toContain("2 个场景")
    expect(screen.getByTestId("prompt-registry-scene-chapter")).toBeTruthy()
    expect(screen.getByTestId("prompt-registry-scene-misc")).toBeTruthy()
  })

  it("预览默认收起，点击后显示占位符骨架", () => {
    render(<PromptRegistryPanel entries={entries} />)
    expect(screen.queryByTestId("prompt-registry-preview-chapterGeneration")).toBeNull()
    fireEvent.click(screen.getByTestId("prompt-registry-toggle-chapterGeneration"))
    expect(screen.getByTestId("prompt-registry-preview-chapterGeneration").textContent).toContain("«arg1»")
  })

  it("预览不可用的条目：按钮文案显式说明，展开显示错误原因", () => {
    render(<PromptRegistryPanel entries={entries} />)
    expect(screen.getByTestId("prompt-registry-toggle-chapterBroken").textContent).toContain("预览不可用")
    fireEvent.click(screen.getByTestId("prompt-registry-toggle-chapterBroken"))
    expect(screen.getByTestId("prompt-registry-preview-chapterBroken").textContent).toBe("boom")
  })

  it("两条 N/A 明示未实现（不伪装成已有功能）", () => {
    render(<PromptRegistryPanel entries={entries} />)
    expect(screen.getByTestId("prompt-registry-na-usage").textContent).toContain("N/A")
    expect(screen.getByTestId("prompt-registry-na-compose").textContent).toContain("N/A")
    expect(screen.getByTestId("prompt-registry-scope").textContent).toContain("«argN»")
  })

  it("默认（不注入）：真的从 PROMPTS 枚举，条数 > 0", () => {
    render(<PromptRegistryPanel />)
    expect(screen.getByTestId("prompt-registry-panel").textContent).toMatch(/\d+ 条/)
    expect(screen.getByTestId("prompt-registry-scene-chapter")).toBeTruthy()
  })
})
