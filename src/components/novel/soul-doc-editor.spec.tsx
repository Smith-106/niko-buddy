// @vitest-environment jsdom
/**
 * SoulDocEditor — 项目灵魂文档编辑器。
 * 覆盖：无项目跳过加载、加载成功/失败、保存成功/失败、空内容禁用保存、消息展示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

const wiki = vi.hoisted(() => ({
  state: { project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const soulDoc = vi.hoisted(() => ({
  readSoulDoc: vi.fn(async () => "初始灵魂文档内容"),
  writeSoulDoc: vi.fn(async () => {}),
}))

vi.mock("@/lib/novel/soul-doc", () => ({
  readSoulDoc: soulDoc.readSoulDoc,
  writeSoulDoc: soulDoc.writeSoulDoc,
}))

const i18nMock = vi.hoisted(() => ({
  t: vi.fn((key: string) => (key === "novel.soul.saveProjectSoul" ? "保存项目灵魂" : key)),
}))

vi.mock("@/i18n", () => ({
  default: { t: i18nMock.t },
}))

import { SoulDocEditor } from "./soul-doc-editor"

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  soulDoc.readSoulDoc.mockResolvedValue("初始灵魂文档内容")
  soulDoc.writeSoulDoc.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe("SoulDocEditor", () => {
  it("skips loading when no project is open", async () => {
    wiki.state.project = null
    render(<SoulDocEditor />)
    expect(soulDoc.readSoulDoc).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toHaveValue("")
  })

  it("loads the soul doc content on mount", async () => {
    render(<SoulDocEditor />)
    expect(await screen.findByRole("textbox")).toHaveValue("初始灵魂文档内容")
    expect(soulDoc.readSoulDoc).toHaveBeenCalledWith("E:/Novel")
  })

  it("falls back to empty content when loading fails", async () => {
    soulDoc.readSoulDoc.mockRejectedValue(new Error("no file"))
    render(<SoulDocEditor />)
    expect(await screen.findByRole("textbox")).toHaveValue("")
  })

  it("disables save when content is empty", async () => {
    soulDoc.readSoulDoc.mockResolvedValue("")
    render(<SoulDocEditor />)
    const saveButton = await screen.findByRole("button", { name: "保存项目灵魂" })
    expect(saveButton).toBeDisabled()
  })

  it("saves edits and shows the success message", async () => {
    render(<SoulDocEditor />)
    const textbox = await screen.findByRole("textbox")
    fireEvent.change(textbox, { target: { value: "新灵魂文档" } })
    fireEvent.click(screen.getByRole("button", { name: "保存项目灵魂" }))
    expect(await screen.findByText("novel.soul.saveProjectSoulSuccess")).toBeInTheDocument()
    expect(soulDoc.writeSoulDoc).toHaveBeenCalledWith("E:/Novel", "新灵魂文档")
    // 源码无自动清除定时器（soul-doc-editor.tsx handleSave 只 setMessage）
    // → 消息保持显示，直至下次保存/失败覆盖
    expect(screen.getByText("novel.soul.saveProjectSoulSuccess")).toBeInTheDocument()
  })

  it("reports save failure with the failed message", async () => {
    soulDoc.writeSoulDoc.mockRejectedValue(new Error("io"))
    render(<SoulDocEditor />)
    const textbox = await screen.findByRole("textbox")
    fireEvent.change(textbox, { target: { value: "内容" } })
    fireEvent.click(screen.getByRole("button", { name: "保存项目灵魂" }))
    expect(await screen.findByText("novel.soul.saveProjectSoulFailed")).toBeInTheDocument()
  })

  it("does nothing when save is clicked without a project", async () => {
    wiki.state.project = null
    render(<SoulDocEditor />)
    // 无项目时 textarea 仍可编辑 → 按钮可用 → handleSave 的 !project 守卫生效
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "无项目内容" } })
    fireEvent.click(screen.getByRole("button", { name: "保存项目灵魂" }))
    await waitFor(() => expect(soulDoc.writeSoulDoc).not.toHaveBeenCalled())
  })

  it("shows the label and placeholder from i18n", async () => {
    render(<SoulDocEditor />)
    await screen.findByRole("textbox")
    expect(screen.getByText("novel.soul.projectSoul")).toBeInTheDocument()
    expect(screen.getByText("novel.soul.projectSoulDesc")).toBeInTheDocument()
  })
})
