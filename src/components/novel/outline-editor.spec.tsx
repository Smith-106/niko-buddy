// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/novel/outline-editor.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  within,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { OutlineCreatorDialog } from "./outline-editor"
import type { ReactNode } from "react"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "@/lib/llm-providers"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { FileNode } from "@/types/wiki"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    project: { id: string; name: string; path: string } | null
    llmConfig: Record<string, unknown>
    setFileTree: ReturnType<typeof vi.fn>
    bumpDataVersion: ReturnType<typeof vi.fn>
  } = {
    project: null,
    llmConfig: { provider: "openai", model: "gpt-4o" },
    setFileTree: vi.fn(),
    bumpDataVersion: vi.fn(),
  }
  return {
    state,
    t: vi.fn((key: string) => key),
    streamChat: vi.fn<(config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal, requestOverrides?: RequestOverrides) => Promise<void>>(async () => {}),
    writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
    listDirectory: vi.fn<(path: string) => Promise<FileNode[]>>(async () => []),
    createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
    outlineGeneration: vi.fn<(genre: string, scale: string, premise: string, context?: string) => string>(() => "generated-outline-prompt"),
    normalizePath: vi.fn((p: string) => p),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/commands/fs", () => ({
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
  createDirectory: mocks.createDirectory,
}))

vi.mock("@/lib/novel/prompt-templates", () => ({
  PROMPTS: { outlineGeneration: mocks.outlineGeneration },
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
}))

// Pass-through dialog so the form is always reachable in jsdom.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}))

vi.mock("@/components/ui/button", () => ({
  // NOTE: `disabled` is intentionally NOT forwarded — React/jsdom never
  // dispatch clicks on disabled buttons, which would make the component's
  // own `if (!title.trim()) setError(...)` guard (lines 66-67) unreachable.
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

const PROJECT = { id: "p1", name: "MyBook", path: "/p/mybook" }
const TITLE_PLACEHOLDER = "novel.outline.titlePlaceholder"
const PREMISE_PLACEHOLDER = "novel.outline.premisePlaceholder"

function titleInput(): HTMLInputElement {
  return screen.getByPlaceholderText(TITLE_PLACEHOLDER) as HTMLInputElement
}

function premiseInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PREMISE_PLACEHOLDER) as HTMLTextAreaElement
}

function typeSelect(): HTMLSelectElement {
  return document.querySelector("select") as HTMLSelectElement
}

function createButton(): HTMLButtonElement {
  const el = screen.getByText("novel.outline.create").closest("button")
  if (!el) throw new Error("create button not found")
  return el as HTMLButtonElement
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.state.project = PROJECT
  mocks.state.setFileTree.mockClear()
  mocks.state.bumpDataVersion.mockClear()
  mocks.streamChat.mockClear()
  mocks.streamChat.mockResolvedValue(undefined)
  mocks.writeFile.mockClear()
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.listDirectory.mockClear()
  mocks.listDirectory.mockResolvedValue([{ name: "wiki", path: "/p/mybook/wiki", is_dir: true, children: [] }])
  mocks.createDirectory.mockClear()
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.outlineGeneration.mockClear()
  mocks.normalizePath.mockClear()
  mocks.normalizePath.mockImplementation((p: string) => p)
})

describe("OutlineCreatorDialog", () => {
  it("无项目时 handleCreate 直接返回（不写文件不报错）", () => {
    mocks.state.project = null
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(titleInput(), { target: { value: "Some Title" } })
    expect(createButton().disabled).toBe(false)
    fireEvent.click(createButton())
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.outline.titleRequired")).not.toBeInTheDocument()
  })

  it("标题为空时点击创建 → titleRequired 错误（真实 UI 中按钮禁用）", () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    // Button mock 不转发 disabled：直接点击以覆盖 handleCreate 内的 titleRequired 分支
    fireEvent.click(createButton())
    expect(screen.getByText("novel.outline.titleRequired")).toBeInTheDocument()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("useAi 开启但 premise 为空 → premiseRequired 错误", () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByLabelText("novel.outline.useAi"))
    fireEvent.change(titleInput(), { target: { value: "T" } })
    fireEvent.click(screen.getByText("novel.outline.createWithAi"))
    expect(screen.getByText("novel.outline.premiseRequired")).toBeInTheDocument()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("useAi + streamChat 回调错误 → 显示错误并提前返回", async () => {
    mocks.streamChat.mockImplementation(
      async (_cfg: unknown, _msgs: unknown, callbacks: { onToken: (t: string) => void; onError: (e: Error) => void }) => {
        callbacks.onToken("partial")
        callbacks.onError(new Error("llm-boom"))
      },
    )
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByLabelText("novel.outline.useAi"))
    fireEvent.change(titleInput(), { target: { value: "AI Title" } })
    fireEvent.change(premiseInput(), { target: { value: "A premise" } })
    expect(screen.getByText("novel.outline.createWithAi")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.outline.createWithAi"))

    await waitFor(() => {
      expect(screen.getByText("llm-boom")).toBeInTheDocument()
    })
    expect(mocks.outlineGeneration).toHaveBeenCalledWith("novel.outline.type.story-outline", "", "A premise")
    expect(mocks.streamChat).toHaveBeenCalledWith(
      mocks.state.llmConfig,
      [{ role: "user", content: "generated-outline-prompt" }],
      expect.any(Object),
    )
    // 提前 return：不创建目录、不写文件
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("useAi 成功：写入文件、刷新树、bumpDataVersion、展示完成面板", async () => {
    mocks.streamChat.mockImplementation(
      async (_cfg: unknown, _msgs: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken("token-a")
        callbacks.onToken("token-b")
        callbacks.onDone()
      },
    )
    const onOpenChange = vi.fn()
    const { rerender } = render(<OutlineCreatorDialog open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByLabelText("novel.outline.useAi"))
    fireEvent.change(titleInput(), { target: { value: "AI Title" } })
    fireEvent.change(premiseInput(), { target: { value: "A premise" } })
    fireEvent.click(screen.getByText("novel.outline.createWithAi"))

    await waitFor(() => {
      expect(screen.getByText("novel.outline.created")).toBeInTheDocument()
    })
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/outlines/ai-title.md",
      expect.stringContaining("token-atoken-b"),
    )
    expect(mocks.listDirectory).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()

    // done 面板的关闭按钮 → handleClose：reset + onOpenChange(false)
    fireEvent.click(screen.getByText("project.cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    rerender(<OutlineCreatorDialog open={false} onOpenChange={onOpenChange} />)
    expect(titleInput().value).toBe("")
    expect(screen.queryByText("novel.outline.created")).not.toBeInTheDocument()
  })

  it("volume-outline：volume_number frontmatter + volume- 文件名前缀", async () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(typeSelect(), { target: { value: "volume-outline" } })
    const volumeInput = screen.getByPlaceholderText("1")
    fireEvent.change(volumeInput, { target: { value: "2" } })
    fireEvent.change(titleInput(), { target: { value: "My Volume" } })
    fireEvent.click(createButton())

    await waitFor(() => {
      expect(screen.getByText("novel.outline.created")).toBeInTheDocument()
    })
    const [path, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(path).toBe("/p/mybook/wiki/outlines/volume-2-my-volume.md")
    expect(content).toContain("volume_number: 2")
    expect(content).not.toContain("chapter_number")
    expect(content).toContain("outline_type: volume-outline")
  })

  it("chapter-outline：chapter_number frontmatter + chapter- 文件名前缀", async () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(typeSelect(), { target: { value: "chapter-outline" } })
    const chapterInput = screen.getByPlaceholderText("1")
    fireEvent.change(chapterInput, { target: { value: "3" } })
    fireEvent.change(titleInput(), { target: { value: "Chapter Three" } })
    fireEvent.click(createButton())

    await waitFor(() => {
      expect(screen.getByText("novel.outline.created")).toBeInTheDocument()
    })
    const [path, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(path).toBe("/p/mybook/wiki/outlines/chapter-3-chapter-three.md")
    expect(content).toContain("chapter_number: 3")
    expect(content).not.toContain("volume_number")
  })

  it("story-outline：文件名清洗（非法字符→-、空白→-、小写），无编号 frontmatter", async () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(titleInput(), { target: { value: 'My: Cool Title?' } })
    fireEvent.click(createButton())

    await waitFor(() => {
      expect(screen.getByText("novel.outline.created")).toBeInTheDocument()
    })
    const [path, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(path).toBe("/p/mybook/wiki/outlines/my--cool-title-.md")
    expect(content).not.toContain("volume_number")
    expect(content).not.toContain("chapter_number")
    // 非 AI 时使用默认正文占位
    expect(content).toContain("# My: Cool Title?")
  })

  it("catch 分支：Error 对象 → 显示 message", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("disk-full"))
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(titleInput(), { target: { value: "T" } })
    fireEvent.click(createButton())
    await waitFor(() => {
      expect(screen.getByText("disk-full")).toBeInTheDocument()
    })
    expect(screen.queryByText("novel.outline.created")).not.toBeInTheDocument()
  })

  it("catch 分支：非 Error 抛出 → String(err)", async () => {
    mocks.createDirectory.mockRejectedValueOnce("boom-string")
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(titleInput(), { target: { value: "T" } })
    fireEvent.click(createButton())
    await waitFor(() => {
      expect(screen.getByText("boom-string")).toBeInTheDocument()
    })
  })

  it("生成中状态：按钮禁用 + generating 文案 + 表单禁用", async () => {
    let resolveStream: (() => void) | undefined
    mocks.streamChat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStream = resolve
        }),
    )
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByLabelText("novel.outline.useAi"))
    fireEvent.change(titleInput(), { target: { value: "T" } })
    fireEvent.change(premiseInput(), { target: { value: "P" } })
    fireEvent.click(screen.getByText("novel.outline.createWithAi"))

    const genBtn = screen.getByText("novel.outline.generating").closest("button") as HTMLButtonElement
    expect(genBtn).toBeInTheDocument()
    expect(titleInput().disabled).toBe(true)
    expect(typeSelect().disabled).toBe(true)

    resolveStream?.()
    await waitFor(() => {
      expect(screen.getByText("novel.outline.created")).toBeInTheDocument()
    })
  })

  it("取消按钮（表单态）→ reset + onOpenChange(false)", () => {
    const onOpenChange = vi.fn()
    render(<OutlineCreatorDialog open onOpenChange={onOpenChange} />)
    fireEvent.change(titleInput(), { target: { value: "Abandoned" } })
    fireEvent.click(screen.getByText("project.cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(titleInput().value).toBe("")
  })

  it("渲染三种大纲类型选项", () => {
    render(<OutlineCreatorDialog open onOpenChange={vi.fn()} />)
    const options = within(typeSelect()).getAllByRole("option")
    expect(options.map((o) => o.getAttribute("value"))).toEqual([
      "story-outline",
      "volume-outline",
      "chapter-outline",
    ])
  })
})
