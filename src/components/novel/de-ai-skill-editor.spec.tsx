// @vitest-environment jsdom
/**
 * DeAiSkillEditor — 去 AI 味 Skill 编辑器。
 * 覆盖：无项目跳过、加载成功/失败（默认规则 + 提示条）、保存成功/失败、
 * 空内容禁用保存、重置为默认、2s 消息清除、使用提示列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

const wiki = vi.hoisted(() => ({
  state: { project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
    
  }
})

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async () => "自定义去AI规则"),
  writeFileAtomic: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: fsMock.readFile,
      writeFileAtomic: fsMock.writeFileAtomic,
    
  }
})

const pathMock = vi.hoisted(() => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: pathMock.join,
}))

import { DeAiSkillEditor } from "./de-ai-skill-editor"
import defaultDeAiSkill from "../../../skills/de-ai-writing/SKILL.md?raw"
import { TIERED_DEAI_TABLE } from "@/lib/novel"

const DEFAULT_RULE_TEXT = defaultDeAiSkill.trim().replace(/\r/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  fsMock.readFile.mockResolvedValue("自定义去AI规则")
  fsMock.writeFileAtomic.mockResolvedValue(undefined)
  pathMock.join.mockImplementation(async (...parts: string[]) => parts.join("/"))
})

afterEach(() => cleanup())

describe("DeAiSkillEditor", () => {
  it("loads the project custom skill on mount", async () => {
    render(<DeAiSkillEditor />)
    expect(await screen.findByRole("textbox")).toHaveValue("自定义去AI规则")
    expect(pathMock.join).toHaveBeenCalledWith("E:/Novel", "de-ai-skill.txt")
    expect(fsMock.readFile).toHaveBeenCalledWith("E:/Novel/de-ai-skill.txt")
    // 非默认 → 无默认提示条
    expect(screen.queryByText(/当前使用系统默认skill/)).not.toBeInTheDocument()
  })

  it("does nothing when no project is open", () => {
    wiki.state.project = null
    render(<DeAiSkillEditor />)
    expect(fsMock.readFile).not.toHaveBeenCalled()
  })

  it("guards handleSave without a project (no writeFileAtomic)", async () => {
    wiki.state.project = null
    render(<DeAiSkillEditor />)
    const textbox = await screen.findByRole("textbox")
    // 无项目时 loadSkill 不会执行 → 内容为空 → 先输入使保存按钮可用
    fireEvent.change(textbox, { target: { value: "规则" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    // de-ai-skill-editor.tsx handleSave 的 `if (!project) return` 守卫命中
    expect(fsMock.writeFileAtomic).not.toHaveBeenCalled()
    expect(screen.queryByText("保存成功")).not.toBeInTheDocument()
  })

  it("falls back to the system default skill and shows the hint when loading fails", async () => {
    fsMock.readFile.mockRejectedValue(new Error("no file"))
    render(<DeAiSkillEditor />)
    const textbox = await screen.findByRole("textbox")
    expect(textbox).toHaveValue(DEFAULT_RULE_TEXT)
    expect(screen.getByText(/当前使用系统默认skill/)).toBeInTheDocument()
  })

  it("saves the content, shows the success message and clears it after 2s", async () => {
    render(<DeAiSkillEditor />)
    const textbox = await screen.findByRole("textbox")
    fireEvent.change(textbox, { target: { value: "新规则" } })
    // setTimeout 在点击保存时才调度（de-ai-skill-editor.tsx handleSave finally）→
    // 必须先启用 fake timers 再触发点击，advanceTimersByTime 才能推动它
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存" }))
        for (let i = 0; i < 8; i++) await Promise.resolve()
      })
      expect(screen.getByText("保存成功")).toBeInTheDocument()
      expect(fsMock.writeFileAtomic).toHaveBeenCalledWith("E:/Novel/de-ai-skill.txt", "新规则")
      // 保存后 isDefault → false
      expect(screen.queryByText(/当前使用系统默认skill/)).not.toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByText("保存成功")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a save failure", async () => {
    fsMock.writeFileAtomic.mockRejectedValue(new Error("io"))
    render(<DeAiSkillEditor />)
    await screen.findByRole("textbox")
    // 等内容异步加载完成，保存按钮解除 disabled（全量运行下 readFile 可能延迟）
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(await screen.findByText("保存失败，请稍后重试")).toBeInTheDocument()
  })

  it("disables save while saving and when content is empty", async () => {
    let resolveWrite!: (v: void) => void
    fsMock.writeFileAtomic.mockImplementationOnce(() => new Promise((res) => { resolveWrite = res }))
    render(<DeAiSkillEditor />)
    await screen.findByRole("textbox")
    const saveButton = screen.getByRole("button", { name: "保存" })
    expect(saveButton).not.toBeDisabled()
    fireEvent.click(saveButton)
    // 保存中 → 文案 保存中... + disabled
    expect(await screen.findByRole("button", { name: "保存中..." })).toBeDisabled()
    resolveWrite(undefined)
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存中..." })).not.toBeInTheDocument())

    // 清空内容 → 禁用
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } })
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled()
  })

  it("resets to the default rules and shows the message", async () => {
    render(<DeAiSkillEditor />)
    const textbox = await screen.findByRole("textbox")
    fireEvent.change(textbox, { target: { value: "改乱了" } })
    // 同上：重置的 setTimeout 在点击时才调度（handleReset）→ 先启用 fake timers
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole("button", { name: "重置为默认" }))
      expect(screen.getByRole("textbox")).toHaveValue(DEFAULT_RULE_TEXT)
      expect(screen.getByText("已重置为默认规则")).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByText("已重置为默认规则")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders the label, usage hints and save button", async () => {
    render(<DeAiSkillEditor />)
    await screen.findByRole("textbox")
    expect(screen.getByText("去AI味技能")).toBeInTheDocument()
    expect(screen.getByText("使用提示：")).toBeInTheDocument()
    expect(screen.getByText(/编辑规则后点击"保存"/)).toBeInTheDocument()
    expect(screen.getByText(/系统默认使用 de-AI-writing skill/)).toBeInTheDocument()
    expect(screen.getByText(/完整skill系统位于软件安装目录/)).toBeInTheDocument()
  })
})

describe("DeAiSkillEditor tiered", () => {
  async function openTiered() {
    const { container } = render(<DeAiSkillEditor />)
    await screen.findByRole("textbox")
    fireEvent.click(screen.getByText("结构化分级"))
    // 等待分级表渲染：统计条 + 表格
    expect(await screen.findByText(new RegExp(`共 ${TIERED_DEAI_TABLE.length} 词`))).toBeInTheDocument()
    return container
  }

  it("shows stats and full table after switching tabs", async () => {
    const container = await openTiered()
    // computeTieredDeAiStats 接线：总数 + 各档 + 权重范围
    expect(screen.getByText(new RegExp(`共 ${TIERED_DEAI_TABLE.length} 词`))).toBeInTheDocument()
    const rows = container.querySelectorAll("tbody tr")
    expect(rows.length).toBe(TIERED_DEAI_TABLE.length)
    expect(screen.getByText(new RegExp(`显示 ${TIERED_DEAI_TABLE.length}/${TIERED_DEAI_TABLE.length} 条`))).toBeInTheDocument()
    // 首词真实渲染（行为断言非 toBeDefined）
    expect(container.querySelector("tbody tr td")?.textContent).toBe(TIERED_DEAI_TABLE[0].term)
  })

  it("filters by tier (filterTier 分支)", async () => {
    const container = await openTiered()
    const selects = container.querySelectorAll("select")
    // 第一个 select 为过滤器（其余为行内分级 select）
    const filter = selects[0] as HTMLSelectElement
    const count1A = TIERED_DEAI_TABLE.filter((e) => e.tier === "1A").length
    fireEvent.change(filter, { target: { value: "1A" } })
    expect(screen.getByText(new RegExp(`显示 ${count1A}/${TIERED_DEAI_TABLE.length} 条`))).toBeInTheDocument()
    const rows = container.querySelectorAll("tbody tr")
    expect(rows.length).toBe(count1A)
    // 行内 tier select 全为 1A（过滤正确性）
    const rowSelects = container.querySelectorAll("tbody select")
    expect(rowSelects.length).toBe(count1A)
    rowSelects.forEach((s) => expect((s as HTMLSelectElement).value).toBe("1A"))
  })

  it("searches by term / category / suggestion (三路 OR 分支）", async () => {
    const container = await openTiered()
    const search = container.querySelector("div.flex.items-center.gap-2 input") as HTMLInputElement
    expect(search).toBeTruthy()
    // term 命中：首词
    fireEvent.change(search, { target: { value: TIERED_DEAI_TABLE[0].term } })
    expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0)
    expect(container.querySelector("tbody tr td")?.textContent).toContain(TIERED_DEAI_TABLE[0].term)
    // category 命中：总结腔（term 不含该串，category 含）
    fireEvent.change(search, { target: { value: "总结腔" } })
    const catRows = container.querySelectorAll("tbody tr")
    expect(catRows.length).toBeGreaterThan(0)
    // suggestion 命中：删掉（term/category 多数不含，suggestion 含）
    fireEvent.change(search, { target: { value: "删掉" } })
    expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0)
    // 清空恢复全量
    fireEvent.change(search, { target: { value: "" } })
    expect(container.querySelectorAll("tbody tr").length).toBe(TIERED_DEAI_TABLE.length)
  })

  it("tier change marks dirty and shows badge (handleTierChange)", async () => {
    const container = await openTiered()
    expect(screen.queryByText(/\(\d+改\)/)).not.toBeInTheDocument()
    const firstRowSelect = container.querySelector("tbody select") as HTMLSelectElement
    const from = firstRowSelect.value as "1A" | "1B" | "3"
    const to = from === "1A" ? "1B" : "1A"
    fireEvent.change(firstRowSelect, { target: { value: to } })
    // 脏标记 badge + 行高亮
    expect(await screen.findByText("(1改)")).toBeInTheDocument()
    expect(firstRowSelect.value).toBe(to)
    expect(container.querySelector("tbody tr")?.className).toContain("bg-warning")
  })

  it("weight change clamps to [0,1] and marks dirty (handleWeightChange)", async () => {
    const container = await openTiered()
    const range = container.querySelector('tbody input[type="range"]') as HTMLInputElement
    expect(range).toBeTruthy()
    fireEvent.change(range, { target: { value: "0.5" } })
    expect(screen.getByText("(1改)")).toBeInTheDocument()
    expect(container.querySelector("tbody tr td:nth-child(4) span")?.textContent).toBe("0.5")
    // 上溢钳位到 1.0：Math.max/min/round 分支
    fireEvent.change(range, { target: { value: "5" } })
    expect(container.querySelector("tbody tr td:nth-child(4) span")?.textContent).toBe("1.0")
    // 下溢钳位到 0.0
    fireEvent.change(range, { target: { value: "-1" } })
    expect(container.querySelector("tbody tr td:nth-child(4) span")?.textContent).toBe("0.0")
  })

  it("suggestion change marks dirty (handleSuggestionChange)", async () => {
    const container = await openTiered()
    const input = container.querySelector("tbody tr td:last-child input") as HTMLInputElement
    expect(input).toBeTruthy()
    const next = `${input.value}-改`
    fireEvent.change(input, { target: { value: next } })
    expect(input.value).toBe(next)
    expect(screen.getByText("(1改)")).toBeInTheDocument()
  })

  it("reset table clears dirty and shows message (handleResetTable + timeout)", async () => {    const container = await openTiered()
    const firstRowSelect = container.querySelector("tbody select") as HTMLSelectElement
    const from = firstRowSelect.value as "1A" | "1B" | "3"
    fireEvent.change(firstRowSelect, { target: { value: from === "1A" ? "1B" : "1A" } })
    expect(screen.getByText("(1改)")).toBeInTheDocument()
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByText("重置分级表"))
      // 脏清除 + 默认恢复
      expect(screen.queryByText(/\(\d+改\)/)).not.toBeInTheDocument()
      const restored = container.querySelector("tbody select") as HTMLSelectElement
      expect(restored.value).toBe(TIERED_DEAI_TABLE[0].tier)
      expect(screen.getByText("已重置分级表为默认")).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByText("已重置分级表为默认")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("switches back to free-text tab (170 行）", async () => {
    await openTiered()
    expect(screen.getByText(/显示 .* 条/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("自由文本"))
    // 回到自由文本：textbox 重新出现，分级表卸载
    expect(await screen.findByRole("textbox")).toBeInTheDocument()
    expect(screen.queryByText(/显示 .* 条/)).not.toBeInTheDocument()
  })
})
