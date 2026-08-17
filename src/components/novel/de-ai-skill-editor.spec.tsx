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

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async () => "自定义去AI规则"),
  writeFile: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMock.readFile,
  writeFile: fsMock.writeFile,
}))

const pathMock = vi.hoisted(() => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: pathMock.join,
}))

import { DeAiSkillEditor } from "./de-ai-skill-editor"
import defaultDeAiSkill from "../../../skills/de-ai-writing/SKILL.md?raw"

const DEFAULT_RULE_TEXT = defaultDeAiSkill.trim().replace(/\r/g, "")

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  fsMock.readFile.mockResolvedValue("自定义去AI规则")
  fsMock.writeFile.mockResolvedValue(undefined)
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

  it("guards handleSave without a project (no writeFile)", async () => {
    wiki.state.project = null
    render(<DeAiSkillEditor />)
    const textbox = await screen.findByRole("textbox")
    // 无项目时 loadSkill 不会执行 → 内容为空 → 先输入使保存按钮可用
    fireEvent.change(textbox, { target: { value: "规则" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    // de-ai-skill-editor.tsx handleSave 的 `if (!project) return` 守卫命中
    expect(fsMock.writeFile).not.toHaveBeenCalled()
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
      expect(fsMock.writeFile).toHaveBeenCalledWith("E:/Novel/de-ai-skill.txt", "新规则")
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
    fsMock.writeFile.mockRejectedValue(new Error("io"))
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
    let resolveWrite!: (v: unknown) => void
    fsMock.writeFile.mockImplementationOnce(() => new Promise((res) => { resolveWrite = res }))
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
    expect(screen.getByText("去AI味Skill")).toBeInTheDocument()
    expect(screen.getByText("使用提示：")).toBeInTheDocument()
    expect(screen.getByText(/编辑规则后点击"保存"/)).toBeInTheDocument()
    expect(screen.getByText(/系统默认使用 de-AI-writing skill/)).toBeInTheDocument()
    expect(screen.getByText(/完整skill系统位于软件安装目录/)).toBeInTheDocument()
  })
})
