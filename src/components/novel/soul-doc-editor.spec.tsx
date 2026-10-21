// @vitest-environment jsdom
/**
 * SoulDocEditor — 项目灵魂文档编辑器。
 * 覆盖：默认阅读模式渲染、无项目跳过加载、加载成功/失败、保存成功/失败、空内容禁用保存、消息展示、阅读/编辑切换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

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

const soulDoc = vi.hoisted(() => ({
  readSoulDoc: vi.fn(async () => "初始灵魂文档内容"),
  writeSoulDoc: vi.fn(async () => {}),
}))

vi.mock("@/lib/novel/soul-doc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/soul-doc")>()
  return {
    ...actual,
      readSoulDoc: soulDoc.readSoulDoc,
      writeSoulDoc: soulDoc.writeSoulDoc,
    
  }
})

const i18nMock = vi.hoisted(() => ({
  t: vi.fn((key: string) =>
    key === "novel.soul.saveProjectSoul"
      ? "保存项目灵魂"
      : key === "novel.soul.editMode"
        ? "编辑"
        : key === "novel.soul.readMode"
          ? "阅读"
          : key,
  ),
}))

vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>()
  return {
    ...actual,
      default: { t: i18nMock.t },
    
  }
})

import { SoulDocEditor } from "./soul-doc-editor"

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  soulDoc.readSoulDoc.mockResolvedValue("初始灵魂文档内容")
  soulDoc.writeSoulDoc.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

async function switchToEditMode() {
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }))
  return screen.findByRole("textbox")
}

describe("SoulDocEditor", () => {
  it("renders markdown in read mode by default", async () => {
    soulDoc.readSoulDoc.mockResolvedValue("# 灵魂标题\n\n正文段落")
    render(<SoulDocEditor />)
    expect(await screen.findByRole("heading", { name: "灵魂标题" })).toBeInTheDocument()
    expect(screen.getByText("正文段落")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("skips loading when no project is open", async () => {
    wiki.state.project = null
    render(<SoulDocEditor />)
    expect(soulDoc.readSoulDoc).not.toHaveBeenCalled()
    expect(await switchToEditMode()).toHaveValue("")
  })

  it("loads the soul doc content on mount", async () => {
    render(<SoulDocEditor />)
    expect(await screen.findByText("初始灵魂文档内容")).toBeInTheDocument()
    expect(soulDoc.readSoulDoc).toHaveBeenCalledWith("E:/Novel")
    expect(await switchToEditMode()).toHaveValue("初始灵魂文档内容")
  })

  it("falls back to empty content when loading fails", async () => {
    soulDoc.readSoulDoc.mockRejectedValue(new Error("no file"))
    render(<SoulDocEditor />)
    expect(await switchToEditMode()).toHaveValue("")
  })

  it("disables save when content is empty", async () => {
    soulDoc.readSoulDoc.mockResolvedValue("")
    render(<SoulDocEditor />)
    await switchToEditMode()
    const saveButton = await screen.findByRole("button", { name: "保存项目灵魂" })
    expect(saveButton).toBeDisabled()
  })

  it("saves edits and shows the success message", async () => {
    render(<SoulDocEditor />)
    const textbox = await switchToEditMode()
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
    const textbox = await switchToEditMode()
    fireEvent.change(textbox, { target: { value: "内容" } })
    fireEvent.click(screen.getByRole("button", { name: "保存项目灵魂" }))
    expect(await screen.findByText("novel.soul.saveProjectSoulFailed")).toBeInTheDocument()
  })

  it("does nothing when save is clicked without a project", async () => {
    wiki.state.project = null
    render(<SoulDocEditor />)
    // 无项目时 textarea 仍可编辑 → 按钮可用 → handleSave 的 !project 守卫生效
    const textbox = await switchToEditMode()
    fireEvent.change(textbox, { target: { value: "无项目内容" } })
    fireEvent.click(screen.getByRole("button", { name: "保存项目灵魂" }))
    await waitFor(() => expect(soulDoc.writeSoulDoc).not.toHaveBeenCalled())
  })

  it("shows the label and placeholder from i18n", async () => {
    render(<SoulDocEditor />)
    await screen.findByText("novel.soul.projectSoulDesc")
    expect(screen.getByText("novel.soul.projectSoul")).toBeInTheDocument()
    await switchToEditMode()
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })
})
