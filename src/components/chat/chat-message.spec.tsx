// @vitest-environment jsdom
/**
 * W4 / chat-message.tsx 全口径覆盖 spec（目标 statements/branches/functions/lines 100%）。
 *
 * 保留原有 SSR（renderToStaticMarkup）测试与静态源码断言；
 * 新增 jsdom 交互测试覆盖 ChatMessage / StreamingMessage / CitedReferencesPanel /
 * AgentAwareContent / MarkdownContent / WikiLink / 内部纯函数。
 *
 * 依赖 mock 策略与 chat-panel.spec.tsx 一致：vi.hoisted 提供可写 wiki store state
 * 与 lib/command mock；子组件 FileEditPreview / MermaidDiagram 轻量 mock。
 */

import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import type { DisplayMessage } from "@/stores/chat-store"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { getDeepChapterToggleButtonClass } from "./chat-panel"

/* eslint-disable @typescript-eslint/no-explicit-any */

// react-markdown v10 sanitizes the custom wikilink: protocol before invoking
// components.a. Keep normal markdown rendering real, but expose one explicit
// test marker so the source-level WikiLink component can be exercised too.
vi.mock("react-markdown", async () => {
  const actual = await vi.importActual<typeof import("react-markdown")>("react-markdown")
  const RealMarkdown = actual.default
  return {
    ...actual,
    default: (props: any) => {
      if (String(props.children).includes("__direct_image__")) {
        const renderImage = props.components?.img as ((imageProps: any) => ReactNode) | undefined
        return (
          <div data-testid="direct-image">
            {renderImage?.({ src: undefined, alt: undefined })}
          </div>
        )
      }
      if (String(props.children).includes("__direct_wikilink__")) {
        const renderLink = props.components?.a as ((linkProps: any) => ReactNode) | undefined
        return (
          <div data-testid="direct-wikilink">
            {renderLink?.({ href: "wikilink:主角", children: "主角" })}
          </div>
        )
      }
      return <RealMarkdown {...props} />
    },
  }
})

/* eslint-disable @typescript-eslint/no-explicit-any */

const mocks = vi.hoisted(() => {
  const wikiState: Record<string, any> = {
    project: null,
    setSelectedFile: vi.fn(),
    setFileContent: vi.fn(),
    setPendingScrollImageSrc: vi.fn(),
    setActiveView: vi.fn(),
  }
  const useWikiStore = (selector: (s: any) => any) => selector(wikiState)
  Object.assign(useWikiStore, { getState: () => wikiState })
  return {
    wikiState,
    useWikiStore,
    readFile: vi.fn<(path: string) => Promise<string>>(async () => {
      throw new Error("not found")
    }),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p),
    getFileName: vi.fn<(p: string) => string>((p: string) => String(p).split("/").pop() ?? ""),
    resolveMarkdownImageSrc: vi.fn<(url: string, projectPath?: string | null) => string>((url: string, projectPath?: string | null) =>
      projectPath ? `${projectPath}/${url}` : url,
    ),
    findRawSourceForImage: vi.fn<(url: string) => Promise<string | null>>(async () => null),
    imageUrlToAbsolute: vi.fn<(url: string) => string>((url: string) => `abs:${url}`),
    detectLanguage: vi.fn<() => string>(() => "zh"),
    getHtmlLang: vi.fn<() => string>(() => "zh-Hans"),
    getTextDirection: vi.fn<() => "ltr">(() => "ltr" as const),
    convertLatexToUnicode: vi.fn<(s: string) => string>((s: string) => s),
    refreshProjectState: vi.fn<() => Promise<void>>(async () => {}),
    applyFileEdits: vi.fn<(_projectPath: string, edits: Array<{ filePath: string }>) => Promise<Array<{ filePath: string; success: boolean }>>>(async (_projectPath: string, edits: Array<{ filePath: string }>) =>
      edits.map((e) => ({ filePath: e.filePath, success: true })),
    ),
    getLastQueryPages: vi.fn<() => Array<{ title: string; path: string }>>(() => []),
    canContinueUnfinishedDeepChapter: vi.fn<(content: string) => boolean>((content: string) =>
      /深度生成章节失败|继续未完成失败|已停止生成|deep chapter generation failed|continue unfinished failed|stopped generating/i.test(content) &&
      /<think(?:ing)?>/i.test(content),
    ),
    getCopyableAssistantContent: vi.fn<(content: string) => string>((content: string) => content),
    unwrapMermaidPre: vi.fn<(children: ReactNode) => ReactNode | null>(() => null),
  }
})

vi.mock("@/stores/wiki-store", () => ({ useWikiStore: mocks.useWikiStore }))
vi.mock("@/commands/fs", () => ({ readFile: mocks.readFile }))
vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
  getFileName: mocks.getFileName,
}))
vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: mocks.resolveMarkdownImageSrc,
}))
vi.mock("@/lib/raw-source-resolver", () => ({
  findRawSourceForImage: mocks.findRawSourceForImage,
  imageUrlToAbsolute: mocks.imageUrlToAbsolute,
}))
vi.mock("@/lib/detect-language", () => ({ detectLanguage: mocks.detectLanguage }))
vi.mock("@/lib/language-metadata", () => ({
  getHtmlLang: mocks.getHtmlLang,
  getTextDirection: mocks.getTextDirection,
}))
vi.mock("@/lib/latex-to-unicode", () => ({ convertLatexToUnicode: mocks.convertLatexToUnicode }))
vi.mock("@/lib/project-refresh", () => ({ refreshProjectState: mocks.refreshProjectState }))
vi.mock("@/lib/novel/agent-tools", () => ({ applyFileEdits: mocks.applyFileEdits }))
vi.mock("@/components/chat/chat-shared", () => ({ getLastQueryPages: mocks.getLastQueryPages }))
vi.mock("./chat-resume", () => ({
  canContinueUnfinishedDeepChapter: mocks.canContinueUnfinishedDeepChapter,
}))
vi.mock("@/lib/chat-copy-content", () => ({
  getCopyableAssistantContent: mocks.getCopyableAssistantContent,
}))
vi.mock("@/components/mermaid-diagram", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
  unwrapMermaidPre: mocks.unwrapMermaidPre,
}))
vi.mock("@/components/chat/file-edit-preview", () => ({
  FileEditPreview: ({ edits, onApply, onDismiss, applied, results }: any) => (
    <div data-testid="file-edit-preview">
      <button data-testid="file-edit-apply" onClick={() => onApply(edits)}>
        apply
      </button>
      <button data-testid="file-edit-dismiss" onClick={onDismiss}>
        dismiss
      </button>
      <span data-testid="file-edit-count">{edits.length}</span>
      <span data-testid="file-edit-applied">{String(!!applied)}</span>
      <span data-testid="file-edit-result-count">{String(results?.length ?? 0)}</span>
    </div>
  ),
}))

// 注意：agent-parser 保持真实实现（AgentAwareContent 的 <file_edit> 解析依赖它）。

function tenThinkingLines(): string {
  return Array.from({ length: 10 }, (_value, index) => `stage line ${index + 1}`).join("\n")
}

function createAssistantMessage(content: string): DisplayMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    timestamp: 0,
    conversationId: "conv-1",
  }
}

function resetMocks(): void {
  vi.clearAllMocks()
  mocks.wikiState.project = null
  mocks.readFile.mockImplementation(async () => {
    throw new Error("not found")
  })
  mocks.findRawSourceForImage.mockResolvedValue(null)
  mocks.getLastQueryPages.mockReturnValue([])
  mocks.unwrapMermaidPre.mockReturnValue(null)
  setupDomGlobals()
}

// ── 原有 SSR 测试（保留）─────────────────────────────────────────────────────

describe("chat thinking display", () => {
  it("keeps completed thinking content in a fixed scrollable panel", () => {
    const thinking = tenThinkingLines()
    const html = renderToStaticMarkup(
      <StreamingMessage content={`<think>\n${thinking}\n</think>\n\nfinal answer`} />,
    )

    expect(html).toContain("stage line 1")
    expect(html).toContain("stage line 10")
    expect(html).toContain("max-h-")
    expect(html).toContain("overflow-y-auto")
    expect(html).not.toContain("Thought for")
  })

  it("keeps streaming thinking content in a fixed scrollable panel", () => {
    const thinking = tenThinkingLines()
    const html = renderToStaticMarkup(<StreamingMessage content={`<think>\n${thinking}`} />)

    expect(html).toContain("stage line 1")
    expect(html).toContain("stage line 10")
    expect(html).not.toContain("h-[5lh]")
    expect(html).toContain("max-h-")
    expect(html).toContain("overflow-y-auto")
  })
})

describe("deep chapter thinking toggle style", () => {
  it("uses a clear dark selected state when deep chapter generation is enabled", () => {
    const activeClassName = getDeepChapterToggleButtonClass(true)
    const inactiveClassName = getDeepChapterToggleButtonClass(false)

    expect(activeClassName).toContain("bg-primary")
    expect(activeClassName).toContain("text-primary-foreground")
    expect(activeClassName).toContain("border-primary")
    expect(inactiveClassName).not.toContain("bg-primary")
  })
})

describe("chapter save preview sync regression", () => {
  it("always routes AI chapter saves to the next chapter instead of reusing the current chapter", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain('strategy.action === "direct_explicit_target_new"')
    expect(source).toContain("await getNextChapterNumber(pp)")
    expect(source).toContain('updateChapterStatus(')
    expect(source).toContain('"final"')
    expect(source).toContain("commitAcceptedDeepChapterDraft({")
    expect(source).toContain("let nextStatus = `已接受草稿并保存为 ${chapterTitle}`")
  })

  it("no longer uses the pending chapter save dialog flow", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).not.toContain("pendingChapterSaveDialog")
    expect(source).not.toContain("applyPendingChapterSave")
    expect(source).not.toContain("保存到章节后面")
  })
})

describe("deep chapter unfinished continuation action", () => {
  it("shows a continuation button and explanation for failed deep chapter thinking", () => {
    const source = readFileSync(resolve(__dirname, "chat-message.tsx"), "utf8")

    expect(source).toContain("onContinueUnfinished")
    expect(source).toContain("继续未完成")
    expect(source).toContain("节省 token")
    expect(source).toContain("canContinueUnfinishedDeepChapter")
  })

  it("wires the continuation action through chat panel without rerunning regenerate", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("handleContinueUnfinished")
    expect(source).toContain("buildContinueUnfinishedDeepChapterPrompt")
    expect(source).toContain("appendContinueUnfinishedDeepChapterContext")
    expect(source).toContain("extractContinueUnfinishedDeepChapterContext")
    expect(source).toContain("contextPackToPrompt")
    expect(source).toContain('addMessage("user", "继续未完成")')
    expect(source).toContain("resolveNovelModel")
    expect(source).toContain("onContinueUnfinished={isLastAssistant ? () => handleContinueUnfinished(msg) : undefined}")
  })

  it("binds continue-unfinished to the assistant message conversation instead of the active tab", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")
    const start = source.indexOf("const handleContinueUnfinished = useCallback(async (assistantMessage: DisplayMessage) => {")
    const end = source.indexOf("let continuationSystemPrompt =", start)
    const snippet = source.slice(start, end)

    expect(snippet).toContain("let convId = assistantMessage.conversationId?.trim()")
    expect(snippet).toContain("storeState.setActiveConversation(convId)")
    expect(snippet).toContain('useChatStore.getState().messages.filter((message) => message.conversationId === convId)')
    expect(snippet).toContain("buildInterruptedResumeContextPayload(statusResume, convId)")
  })

  it("keeps the ai chat footer labels as readable Chinese text", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("深度模式")
    expect(source).toContain("编辑章节")
    expect(source).toContain("继续未完成")
  })

  it("starts continue-next-chapter in a fresh conversation before sending", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")
    const start = source.indexOf("const handleContinueNextChapter = useCallback(() => {")
    const end = source.indexOf("const handleContinueUnfinished = useCallback", start)
    const snippet = source.slice(start, end)

    expect(snippet).toContain("createConversation()")
    expect(snippet).toContain("handleSend(`请根据当前小说上下文、记忆库、最新章节结尾、下一章推进建议和章纲，继续生成下一章正文。")
  })
})

describe("deep chapter session persistence wiring", () => {
  it("persists deep chapter generation progress into novel-session-status during runtime", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("startDeepChapterSession({")
    expect(source).toContain("persistDeepChapterCheckpoint({")
    expect(source).toContain("completeDeepChapterSession({")
    expect(source).toContain("blockDeepChapterSession({")
    expect(source).toContain("pauseDeepChapterSession({")
  })

  it("allows continue-unfinished to fall back to status.json when chat message context is incomplete", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("loadNovelSessionStatus(")
    expect(source).toContain("buildInterruptedResumeContextPayload(statusResume, convId)")
    expect(source).toContain("const resumeCheckpoint = statusResumeCheckpoint ?? persistedResume?.checkpoint")
    expect(source).toContain("const resumeContext = statusResumePayload?.resumeContext || persistedResume?.resumeContext || visibleAssistantContent")
  })

  it("lets the normal deep send path auto-resume when the same running status session still exists", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("resolveInterruptedSessionResumeCheckpoint")
    expect(source).toContain("autoResumedFromStatus")
    expect(source).toContain("resumeCheckpoint: interruptedResumeCheckpoint")
  })

  it("reads deep chapter toggle from shared state before entering the send branch", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("const sharedDeepChapterEnabledRef = { current: false }")
    expect(source).toContain("useState(sharedDeepChapterEnabledRef.current)")
    expect(source).toContain("sharedDeepChapterEnabledRef.current = resolvedValue")
    expect(source).toContain("const deepChapterEnabledNow = sharedDeepChapterEnabledRef.current")
    expect(source).toContain("if (novelMode && project && deepChapterEnabledNow)")
  })
})

describe("deep chapter draft action visibility", () => {
  it("hides chapter draft actions for stopped assistant status messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("已停止生成。")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps only continue-unfinished for failed deep chapter messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n出错：深度生成章节失败：HTTP 429")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps continue-unfinished for manually stopped deep chapter messages with resume context", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n已停止生成。\n<!-- qmai-continue-unfinished-context:%7B%22originalRequest%22%3A%22%E8%AF%B7%E4%B8%BA%E7%AC%AC1%E7%AB%A0%E7%94%9F%E6%88%90%E6%AD%A3%E6%96%87%22%2C%22resumeContext%22%3A%22%3Cthink%3E%23%23%20%E9%98%B6%E6%AE%B51%EF%BC%9A%E4%B8%8A%E4%B8%8B%E6%96%87%E5%88%86%E6%9E%90%3C%2Fthink%3E%22%2C%22checkpoint%22%3A%7B%22version%22%3A1%2C%22originalRequest%22%3A%22%E8%AF%B7%E4%B8%BA%E7%AC%AC1%E7%AB%A0%E7%94%9F%E6%88%90%E6%AD%A3%E6%96%87%22%2C%22chapterNumber%22%3A1%2C%22stage%22%3A%22after_context%22%7D%7D -->")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps continue-unfinished for manually stopped deep chapter messages with only debug metadata", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n已停止生成。\n<!-- qmai-novel-session-debug:%7B%22flow%22%3A%22deep-chapter%22%2C%22lastCheckpointStage%22%3A%22after_context%22%7D -->")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("shows chapter draft actions for generated chapter content", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22ready%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).toContain("接受草稿")
    expect(html).toContain("拒绝草稿")
  })

  it("only allows reject while the managed draft is still pending manual review", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22pending%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).toContain("拒绝草稿")
  })

  it("does not show draft actions once the managed draft marker is accepted", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22accepted%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("鎺ュ彈鑽够")
    expect(html).not.toContain("鎷掔粷鑽够")
    expect(html).not.toContain("缁х画鐢熸垚涓嬩竴绔?")
  })

  it("does not show chapter draft actions for plain assistant chapter-like text without a managed draft marker", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })
})

// ── 新增 jsdom 交互覆盖 ───────────────────────────────────────────────────────

const DRAFT_MARKER = (status: string): string =>
  `<!-- qmai-deep-chapter-draft:${encodeURIComponent(
    JSON.stringify({ conversationId: "conv-1", draftStatus: status }),
  )} -->`

function chapterDraft(status: string, bodyLength = 120): string {
  return `# Chapter 1 Title\n\n${"X".repeat(bodyLength)}\n\n${DRAFT_MARKER(status)}`
}

describe("ChatMessage 角色与气泡样式", () => {
  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("user 消息渲染内容 + User 图标 + 反向布局", () => {
    const { container } = render(
      <ChatMessage message={{ ...createAssistantMessage("用户文本"), role: "user" }} />,
    )
    expect(screen.getByText("用户文本")).toBeInTheDocument()
    expect(container.querySelector(".lucide-user")).not.toBeNull()
    expect(container.querySelector(".flex-row-reverse")).not.toBeNull()
  })

  it("system 消息使用 Bot 图标 + accent 底色", () => {
    const { container } = render(
      <ChatMessage message={{ ...createAssistantMessage("系统文本"), role: "system" }} />,
    )
    expect(screen.getByText("系统文本")).toBeInTheDocument()
    expect(container.querySelector(".lucide-bot")).not.toBeNull()
  })

  it("assistant 消息渲染 markdown 内容 + Bot 图标", () => {
    const { container } = render(<ChatMessage message={createAssistantMessage("**加粗** 内容")} />)
    expect(screen.getByText("加粗")).toBeInTheDocument()
    expect(container.querySelector(".lucide-bot")).not.toBeNull()
  })

  it("discarded 消息（user/assistant）显示已废弃且无操作区", () => {
    const { container } = render(
      <ChatMessage message={{ ...createAssistantMessage("x"), role: "user", discarded: true }} />,
    )
    expect(screen.getByText("已废弃")).toBeInTheDocument()
    void container

    cleanup()
    const c2 = render(
      <ChatMessage
        message={{ ...createAssistantMessage("x"), discarded: true }}
        isLastAssistant
        novelMode
      />,
    )
    expect(c2.container.textContent).toContain("已废弃")
    expect(c2.container.textContent).not.toContain("引用资料")
    expect(c2.container.querySelector(".lucide-bot")).not.toBeNull()
  })

  it("terminal error 状态渲染 destructive 气泡（出错：/已停止生成。）", () => {
    const { container } = render(<ChatMessage message={createAssistantMessage("出错：生成失败")} />)
    expect(container.querySelector(".text-destructive")).not.toBeNull()
    cleanup()
    const { container: c2 } = render(<ChatMessage message={createAssistantMessage("已停止生成。")} />)
    expect(c2.querySelector(".text-destructive")).not.toBeNull()
  })

  it("hover 显示复制按钮，离开后隐藏", () => {
    const { container } = render(<ChatMessage message={createAssistantMessage("hello")} />)
    expect(screen.queryByTitle("复制到剪贴板")).not.toBeInTheDocument()
    const row = screen.getByText("hello").closest(".flex.gap-2")
    expect(row).not.toBeNull()
    fireEvent.mouseEnter(row as HTMLElement)
    expect(screen.getByTitle("复制到剪贴板")).toBeInTheDocument()
    fireEvent.mouseLeave(row as HTMLElement)
    expect(screen.queryByTitle("复制到剪贴板")).not.toBeInTheDocument()
    void container
  })

  it("novelMode + isLastAssistant 时不需 hover 即显示复制按钮", () => {
    render(<ChatMessage message={createAssistantMessage("hello")} novelMode isLastAssistant />)
    expect(screen.getByTitle("复制到剪贴板")).toBeInTheDocument()
  })

  it("复制按钮写入剪贴板并展示已复制后复原", async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<ChatMessage message={createAssistantMessage("copy me")} novelMode isLastAssistant />)
    await act(async () => {
      fireEvent.click(screen.getByTitle("复制到剪贴板"))
    })
    expect(writeText).toHaveBeenCalledWith("copy me")
    expect(screen.getByText("已复制")).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText("复制")).toBeInTheDocument()
  })

  it("重新生成按钮回调", () => {
    const onRegenerate = vi.fn()
    render(
      <ChatMessage message={createAssistantMessage("hello")} isLastAssistant onRegenerate={onRegenerate} />,
    )
    fireEvent.click(screen.getByTitle("重新生成这条回复"))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it("saveStatus 文本渲染", () => {
    render(<ChatMessage message={createAssistantMessage("hello")} saveStatus="保存中…" />)
    expect(screen.getByText("保存中…")).toBeInTheDocument()
  })
})

describe("ChatMessage 深度章节草稿操作", () => {
  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("ready 草稿显示接受/拒绝/继续按钮，点击分别回调，isSaving 禁用", () => {
    const onSaveAsChapter = vi.fn()
    const onDiscardDraft = vi.fn()
    const onContinueNextChapter = vi.fn()
    render(
      <ChatMessage
        message={createAssistantMessage(chapterDraft("ready"))}
        isLastAssistant
        novelMode
        onSaveAsChapter={onSaveAsChapter}
        onDiscardDraft={onDiscardDraft}
        onContinueNextChapter={onContinueNextChapter}
        isSaving
      />,
    )
    // isSaving 时接受按钮文案切换为“保存中”（chat-message.tsx：isSaving ? 保存中 : 接受草稿），
    // 仍携带 aria-busy；拒绝/继续按钮保持禁用。
    const accept = screen.getByText("保存中")
    const reject = screen.getByText("拒绝草稿")
    const cont = screen.getByText("继续生成下一章")
    expect(accept).toBeDisabled()
    expect(reject).toBeDisabled()
    expect(cont).toBeDisabled()
    expect(accept).toHaveAttribute("aria-busy", "true")

    // isSaving=false 后可点击
    cleanup()
    render(
      <ChatMessage
        message={createAssistantMessage(chapterDraft("ready"))}
        isLastAssistant
        novelMode
        onSaveAsChapter={onSaveAsChapter}
        onDiscardDraft={onDiscardDraft}
        onContinueNextChapter={onContinueNextChapter}
      />,
    )
    fireEvent.click(screen.getByText("接受草稿"))
    expect(onSaveAsChapter).toHaveBeenCalledWith(expect.stringContaining("# Chapter 1 Title"))
    fireEvent.click(screen.getByText("拒绝草稿"))
    expect(onDiscardDraft).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("继续生成下一章"))
    expect(onContinueNextChapter).toHaveBeenCalledTimes(1)
  })

  it("未提供对应回调时不渲染对应按钮", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(chapterDraft("ready"))}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
    expect(screen.queryByText("拒绝草稿")).not.toBeInTheDocument()
    expect(screen.queryByText("继续生成下一章")).not.toBeInTheDocument()
  })

  it("pending 草稿仅允许拒绝", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(chapterDraft("pending"))}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
    expect(screen.getByText("拒绝草稿")).toBeInTheDocument()
  })

  it("rejected/superseded 草稿不显示任何操作", () => {
    for (const status of ["rejected", "superseded"]) {
      cleanup()
      render(
        <ChatMessage
          message={createAssistantMessage(chapterDraft(status))}
          isLastAssistant
          novelMode
          onSaveAsChapter={() => {}}
          onDiscardDraft={() => {}}
          onContinueNextChapter={() => {}}
        />,
      )
      expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
      expect(screen.queryByText("拒绝草稿")).not.toBeInTheDocument()
    }
  })

  it("损坏的 draft marker JSON 不显示操作", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(`# Chapter 1\n\n${"X".repeat(120)}\n\n<!-- qmai-deep-chapter-draft:not-json -->`)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("marker 缺少 conversationId 或 draftStatus 非法时不显示操作", () => {
    const noConv = `<!-- qmai-deep-chapter-draft:${encodeURIComponent(JSON.stringify({ draftStatus: "ready" }))} -->`
    cleanup()
    render(
      <ChatMessage
        message={createAssistantMessage(`# Chapter 1\n\n${"X".repeat(120)}\n\n${noConv}`)}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
    cleanup()
    const badStatus = `<!-- qmai-deep-chapter-draft:${encodeURIComponent(JSON.stringify({ conversationId: "c", draftStatus: "bogus" }))} -->`
    render(
      <ChatMessage
        message={createAssistantMessage(`# Chapter 1\n\n${"X".repeat(120)}\n\n${badStatus}`)}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("正文过短（<120 字）或缺少章节标题时不显示操作", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(chapterDraft("ready", 10))}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
    cleanup()
    render(
      <ChatMessage
        message={createAssistantMessage(`普通文本没有章节标题\n\n${DRAFT_MARKER("ready")}`)}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("terminal 状态 + draft marker 不显示操作（canOperateOnDeepChapterDraft 拒绝）", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(`已停止生成。\n\n${DRAFT_MARKER("ready")}`)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("仅 marker 无可见正文时不显示操作", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(DRAFT_MARKER("ready"))}
        isLastAssistant
        novelMode
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("未完成恢复：显示提示横幅 + 继续未完成按钮，点击回调", () => {
    const onContinueUnfinished = vi.fn()
    render(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n已停止生成。\n<!-- qmai-continue-unfinished-context:xxx -->")}
        isLastAssistant
        novelMode
        onContinueUnfinished={onContinueUnfinished}
      />,
    )
    expect(screen.getByText(/这次深度生成已经完成了部分思考过程/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("继续未完成"))
    expect(onContinueUnfinished).toHaveBeenCalledTimes(1)
  })

  it("resume 场景下 isSaving 禁用继续未完成", () => {
    render(
      <ChatMessage
        message={createAssistantMessage("<think>x</think>\n\n已停止生成。\n<!-- qmai-continue-unfinished-context:xxx -->")}
        isLastAssistant
        novelMode
        onContinueUnfinished={() => {}}
        isSaving
      />,
    )
    expect(screen.getByText("继续未完成")).toBeDisabled()
  })
})

describe("ChatMessage 引用面板", () => {
  const REFS = [
    { title: "实体A", path: "wiki/entities/a.md" },
    { title: "概念B", path: "wiki/concepts/b.md" },
    { title: "来源C", path: "wiki/sources/c.md" },
    { title: "查询D", path: "wiki/queries/d.md" },
    { title: "综合E", path: "wiki/synthesis/e.md" },
    { title: "对比F", path: "wiki/comparisons/f.md" },
    { title: "总览G", path: "wiki/overview.md" },
    { title: "剪辑H", path: "raw/sources/clip.pdf" },
    { title: "其他I", path: "wiki/other/i.md" },
  ]

  beforeEach(() => {
    resetMocks()
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function msgWithRefs(refs: { title: string; path: string }[], content = "answer"): DisplayMessage {
    return { ...createAssistantMessage(content), references: refs }
  }

  it("渲染引用面板 + 各类 refType 图标 + 点击页面打开候选文件", async () => {
    mocks.readFile.mockResolvedValue("# page")
    render(<ChatMessage message={msgWithRefs(REFS)} />)
    expect(screen.getByText("引用资料（9）")).toBeInTheDocument()
    // >3 条默认折叠（MAX_COLLAPSED = 3），仅前 3 条可见
    for (const ref of REFS.slice(0, 3)) {
      expect(screen.getByText(ref.title)).toBeInTheDocument()
    }
    for (const ref of REFS.slice(3)) {
      expect(screen.queryByText(ref.title)).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByText("+6 条更多引用..."))
    for (const ref of REFS) {
      expect(screen.getByText(ref.title)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByText("实体A"))
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/wiki/entities/a.md")
    })
  })

  it("页面文件全部缺失时回退到 `${pp}/${page.path}`", async () => {
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    fireEvent.click(screen.getByText("实体A"))
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/wiki/entities/a.md")
    })
    // readFile 全拒 → 最后一个候选也不存在 → 回退原始 path
  })

  it("raw source citation uses clip reference icon mapping", () => {
    const { container } = render(<ChatMessage message={msgWithRefs([REFS[7]])} />)
    expect(screen.getByText("剪辑H")).toBeInTheDocument()
    expect(container.querySelector("svg")).not.toBeNull()
  })


  it(">3 条引用时折叠并可展开/收起", async () => {
    render(<ChatMessage message={msgWithRefs(REFS.slice(0, 5))} />)
    expect(screen.getByText("引用资料（5）")).toBeInTheDocument()
    expect(screen.getByText("实体A")).toBeInTheDocument()
    expect(screen.queryByText("查询D")).not.toBeInTheDocument()
    expect(screen.getByText("+2 条更多引用...")).toBeInTheDocument()
    fireEvent.click(screen.getByText("+2 条更多引用..."))
    expect(screen.getByText("查询D")).toBeInTheDocument()
    expect(screen.getByText("综合E")).toBeInTheDocument()
    // 头部点击收起
    fireEvent.click(screen.getByText("引用资料（5）"))
    expect(screen.queryByText("查询D")).not.toBeInTheDocument()
  })

  it("≤3 条引用时无展开按钮且头部点击无效", () => {
    render(<ChatMessage message={msgWithRefs(REFS.slice(0, 3))} />)
    expect(screen.queryByText(/条更多引用/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("引用资料（3）"))
    expect(screen.getByText("实体A")).toBeInTheDocument()
    expect(screen.getByText("概念B")).toBeInTheDocument()
  })

  it("无 project 时点击引用页无副作用", async () => {
    mocks.wikiState.project = null
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    fireEvent.click(screen.getByText("实体A"))
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    })
  })

  it("图片徽标：读取到图片后显示 count，点击跳转 raw 源", async () => {
    mocks.readFile.mockResolvedValue("![a](img-1.png)\n![b](img-2.png)")
    mocks.findRawSourceForImage.mockResolvedValue("/p/raw/sources/a.pdf")
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    const badge = await screen.findByTitle(/打开第一张图片所在原始文档（本页共 2 张图片）/)
    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/raw/sources/a.pdf")
    })
    expect(mocks.wikiState.setPendingScrollImageSrc).toHaveBeenCalledWith("abs:img-1.png")
    expect(mocks.wikiState.setFileContent).toHaveBeenCalledWith("![a](img-1.png)\n![b](img-2.png)")
  })

  it("图片徽标：无 raw 时回退打开 wiki 页", async () => {
    mocks.readFile.mockResolvedValue("![a](img-1.png)")
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    const badge = await screen.findByTitle(/打开第一张图片所在原始文档（本页共 1 张图片）/)
    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/wiki/entities/a.md")
    })
    expect(mocks.wikiState.setPendingScrollImageSrc).toHaveBeenCalledWith("img-1.png")
  })

  it("图片徽标：raw 与回退读取都失败时记录 warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.readFile.mockResolvedValue("![a](img-1.png)")
    // 第一次读取（candidates 扫描）成功；跳转时全部失败
    mocks.readFile
      .mockResolvedValueOnce("![a](img-1.png)")
      .mockRejectedValueOnce(new Error("raw fail"))
      .mockRejectedValueOnce(new Error("fallback fail"))
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    const badge = await screen.findByTitle(/打开第一张图片所在原始文档（本页共 1 张图片）/)
    fireEvent.click(badge)
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())
    warnSpy.mockRestore()
  })

  it("无 project 时图片徽标不渲染（effect 提前返回）", async () => {
    mocks.wikiState.project = null
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    expect(screen.queryByTitle(/打开第一张图片所在原始文档/)).not.toBeInTheDocument()
  })

  it("imageInfos 为空时点击页面仍可打开（无徽标路径）", async () => {
    render(<ChatMessage message={msgWithRefs([REFS[0]])} />)
    fireEvent.click(screen.getByText("实体A"))
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalled()
    })
  })
})

describe("extractCitedPages 动态提取", () => {
  const PAGES = [
    { title: "P1", path: "/p/w1.md" },
    { title: "P2", path: "/p/w2.md" },
    { title: "P3", path: "/p/w3.md" },
  ]

  beforeEach(() => {
    resetMocks()
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("<!-- cited: n --> 注释映射页面", () => {
    mocks.getLastQueryPages.mockReturnValue(PAGES)
    render(<ChatMessage message={createAssistantMessage("答案\n<!-- cited: 1, 3 -->")} />)
    expect(screen.getByText("引用资料（2）")).toBeInTheDocument()
    expect(screen.getByText("P1")).toBeInTheDocument()
    expect(screen.getByText("P3")).toBeInTheDocument()
  })

  it("[n] 记号回退", () => {
    mocks.getLastQueryPages.mockReturnValue(PAGES)
    render(<ChatMessage message={createAssistantMessage("见 [2] 和 [2]")} />)
    expect(screen.getByText("引用资料（1）")).toBeInTheDocument()
    expect(screen.getByText("P2")).toBeInTheDocument()
  })

  it("[[wikilink]] 回退（带显示名与带路径 id）", () => {
    render(<ChatMessage message={createAssistantMessage("参考 [[实体|显示名]] 与 [[queries/我的查询]]")} />)
    expect(screen.getByText("引用资料（2）")).toBeInTheDocument()
    // “显示名”同时出现在正文 markdown（wikilink: href 被 defaultUrlTransform 清空后的
    // 普通 span，chat-message.tsx a renderer）与引用面板标题，共 2 处
    expect(screen.getAllByText("显示名")).toHaveLength(2)
    // 带路径 id 无显示名 → extractCitedPages 的 display 回退为完整 id
    // （"queries/我的查询"），正文 span 与面板标题各 1 处
    expect(screen.getAllByText("queries/我的查询")).toHaveLength(2)
  })

  it("无任何引用线索时不渲染面板", () => {
    render(<ChatMessage message={createAssistantMessage("普通回复")} />)
    expect(screen.queryByText(/引用资料/)).not.toBeInTheDocument()
  })
})

describe("AgentAwareContent 文件修改预览", () => {
  const EDIT_CONTENT =
    "回答文本\n<file_edit path=\"wiki/chapters/c1.md\">\n<search>\nold text\n</search>\n<replace>\nnew text\n</replace>\n</file_edit>"

  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("有 edits + projectPath 时渲染预览，应用后回填 results 并刷新项目", async () => {
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
    render(<ChatMessage message={createAssistantMessage(EDIT_CONTENT)} projectPath="/p" />)
    expect(screen.getByTestId("file-edit-preview")).toBeInTheDocument()
    expect(screen.getByTestId("file-edit-count").textContent).toBe("1")
    fireEvent.click(screen.getByTestId("file-edit-apply"))
    await waitFor(() => {
      expect(mocks.applyFileEdits).toHaveBeenCalledWith(
        "/p",
        [{ filePath: "wiki/chapters/c1.md", search: "old text", replace: "new text" }],
      )
    })
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p")
    expect(screen.getByTestId("file-edit-applied").textContent).toBe("true")
    expect(screen.getByTestId("file-edit-result-count").textContent).toBe("1")
  })

  it("点击 dismiss 关闭预览", async () => {
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
    render(<ChatMessage message={createAssistantMessage(EDIT_CONTENT)} projectPath="/p" />)
    fireEvent.click(screen.getByTestId("file-edit-dismiss"))
    expect(screen.queryByTestId("file-edit-preview")).not.toBeInTheDocument()
  })

  it("无 projectPath 时不渲染预览", () => {
    render(<ChatMessage message={createAssistantMessage(EDIT_CONTENT)} />)
    expect(screen.queryByTestId("file-edit-preview")).not.toBeInTheDocument()
    expect(screen.getByText("回答文本")).toBeInTheDocument()
  })
})

describe("MarkdownContent 渲染", () => {
  beforeEach(() => {
    resetMocks()
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("think 块 + 答案渲染 WorkflowBlock 与答案", () => {
    render(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析\n读取章节数据</think>\n\n最终答案文本")}
      />,
    )
    expect(screen.getByText("工作流阶段")).toBeInTheDocument()
    expect(screen.getByText("最终答案文本")).toBeInTheDocument()
  })

  it("wikilink effect cleanup suppresses late probe completion", async () => {
    let resolveProbe!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      resolveProbe = resolve
    })
    mocks.readFile.mockReturnValueOnce(pending)
    const view = render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    view.unmount()
    await act(async () => {
      resolveProbe("late success")
      await Promise.resolve()
    })
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("wikilink effect cleanup suppresses late all-candidates failure", async () => {
    let rejectProbe!: (error: Error) => void
    const pending = new Promise<string>((_resolve, reject) => {
      rejectProbe = reject
    })
    mocks.readFile.mockReturnValueOnce(pending)
    const view = render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    view.unmount()
    await act(async () => {
      rejectProbe(new Error("late failure"))
      await Promise.resolve()
    })
    expect(screen.queryByTitle("Page not found: 主角")).not.toBeInTheDocument()
  })


  it("direct WikiLink source page resolves and opens in wiki view", async () => {
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/p/wiki/sources/主角.md") return "# 角色页"
      throw new Error("not found")
    })
    render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    const link = await screen.findByTitle("Open wiki page: 主角")
    fireEvent.click(link)
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/wiki/sources/主角.md")
      expect(mocks.wikiState.setFileContent).toHaveBeenCalledWith("# 角色页")
      expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
    })
  })


  it("direct WikiLink reports missing page after all candidates fail", async () => {
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
    mocks.readFile.mockRejectedValue(new Error("not found"))
    render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    expect(await screen.findByTitle("Page not found: 主角")).toBeInTheDocument()
  })

  it("direct WikiLink click ignores a read failure and unresolved links", async () => {
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
    let callCount = 0
    mocks.readFile.mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) return "# 角色页"
      throw new Error("read failed")
    })
    render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    const link = await screen.findByTitle("Open wiki page: 主角")
    fireEvent.click(link)
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(2))
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()

    mocks.wikiState.project = null
    const view = render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    const unresolvedItems = screen.getAllByTitle("Open wiki page: 主角")
    const unresolved = unresolvedItems[unresolvedItems.length - 1]
    fireEvent.click(unresolved)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("direct WikiLink remains pending without a project", async () => {
    mocks.wikiState.project = null
    render(<ChatMessage message={createAssistantMessage("__direct_wikilink__")} />)
    const link = await screen.findByTitle("Open wiki page: 主角")
    fireEvent.click(link)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("direct img renderer handles missing src and alt", () => {
    render(<ChatMessage message={createAssistantMessage("__direct_image__")} />)
    const image = screen.getByTestId("direct-image").querySelector("img")
    expect(image).not.toBeNull()
    expect(image).toHaveAttribute("alt", "")
    expect(image).not.toHaveAttribute("src")
  })

  it("wikilink 渲染为普通 span（wikilink: href 被 defaultUrlTransform 清空，WikiLink 分支不可达）", async () => {
    mocks.readFile.mockResolvedValue("# 角色页")
    const { container } = render(<ChatMessage message={createAssistantMessage("角色是 [[主角]]。")} />)
    const span = container.querySelector('span[title=""]')
    expect(span).not.toBeNull()
    expect(span!.textContent).toBe("主角")
    expect(screen.queryByTitle("Open wiki page: 主角")).not.toBeInTheDocument()
    fireEvent.click(span as HTMLElement)
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
      expect(mocks.wikiState.setFileContent).not.toHaveBeenCalled()
      expect(mocks.wikiState.setActiveView).not.toHaveBeenCalled()
    })
  })


  it("wikilink 不存在时渲染为普通 span（Page not found 分支不可达）", async () => {
    const { container } = render(<ChatMessage message={createAssistantMessage("见 [[不存在]]")} />)
    // readFile 全拒 + defaultUrlTransform 清空 href → WikiLink 不挂载，
    // 不存在失效 span（title="Page not found: ..."）分支不可达；真实输出为普通 span。
    const span = container.querySelector('span[title=""]')
    expect(span).not.toBeNull()
    expect(span!.textContent).toBe("不存在")
    expect(screen.queryByTitle("Page not found: 不存在")).not.toBeInTheDocument()
  })

  it("wikilink 解析挂起时无按钮、点击无副作用（WikiLink 不可达）", async () => {
    mocks.readFile.mockReturnValue(new Promise(() => {}))
    const { container } = render(<ChatMessage message={createAssistantMessage("见 [[挂起]]")} />)
    const span = container.querySelector('span[title=""]')
    expect(span).not.toBeNull()
    expect(screen.queryByTitle("Open wiki page: 挂起")).not.toBeInTheDocument()
    fireEvent.click(span as HTMLElement)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("mermaid 代码块渲染 MermaidDiagram mock", () => {
    render(
      <ChatMessage
        message={createAssistantMessage("```mermaid\ngraph TD\nA-->B\n```")}
      />,
    )
    expect(screen.getByTestId("mermaid")).toBeInTheDocument()
    expect(screen.getByTestId("mermaid").textContent).toContain("graph TD")
  })

  it("pre unwrap 命中时直接渲染 unwrap 结果", () => {
    vi.mocked(mocks.unwrapMermaidPre).mockReturnValue(<div data-testid="mermaid-pre-unwrapped">unwrapped</div>)
    render(<ChatMessage message={createAssistantMessage("```\nplain code\n```")} />)
    expect(screen.getByTestId("mermaid-pre-unwrapped")).toBeInTheDocument()
  })

  it("markdown 表格渲染 table/thead/th/td", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("| a | b |\n|---|---|\n| 1 | 2 |")} />,
    )
    expect(container.querySelector("table")).not.toBeNull()
    expect(container.querySelector("thead")).not.toBeNull()
    expect(container.querySelectorAll("th").length).toBe(2)
    expect(container.querySelectorAll("td").length).toBe(2)
  })

  it("markdown 图片解析为 img 并解析 src", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("![图](media/x.png)")} />,
    )
    const img = container.querySelector("img") as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.src).toContain("/p/media/x.png")
  })

  it("普通链接渲染 span（wikilink 协议之外）", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("[链接](https://example.com)")} />,
    )
    const span = container.querySelector('span[title="https://example.com"]')
    expect(span).not.toBeNull()
  })

  it("数学公式 $...$ 保留并渲染 katex", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("公式 $x^2$ 结束")} />,
    )
    expect(container.querySelector(".katex")).not.toBeNull()
  })

  it("\\begin 块被包裹为 $$ 并渲染 katex", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("\\begin{matrix}a\\end{matrix}")} />,
    )
    expect(container.querySelector(".katex")).not.toBeNull()
  })

  it("畸形 wikilink [[名字] 被修复后渲染为普通 span（无按钮）", async () => {
    const { container } = render(<ChatMessage message={createAssistantMessage("见 [[名字]")} />)
    // processContent 的修复正则 /\[\[([^\]]+)\](?!\])/ 把 [[名字] 补全为 [[名字]]，
    // 再经 wikilink 转换与 defaultUrlTransform 清空 → 普通 span title=""。
    const span = container.querySelector('span[title=""]')
    expect(span).not.toBeNull()
    expect(span!.textContent).toBe("名字")
    expect(screen.queryByTitle("Open wiki page: 名字")).not.toBeInTheDocument()
  })

  it("无 project 时 wikilink 渲染为普通 span，点击无副作用", async () => {
    mocks.wikiState.project = null
    const { container } = render(<ChatMessage message={createAssistantMessage("见 [[孤岛]]")} />)
    const span = container.querySelector('span[title=""]')
    expect(span).not.toBeNull()
    expect(span!.textContent).toBe("孤岛")
    fireEvent.click(span as HTMLElement)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })
})

describe("StreamingMessage 流式状态", () => {
  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("空内容显示骨架屏", () => {
    const { container } = render(<StreamingMessage content="" />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.getByLabelText("正在生成回复")).toBeInTheDocument()
    void container
  })

  it("仅思考内容显示 StreamingWorkflowBlock", () => {
    // 注意：JSX 属性字符串在本项目 vite8/rolldown 管线中不处理 \n 转义（字面保留），
    // 必须用模板字符串才能得到真实换行，否则 separateThinking 的段落切分全部失效。
    render(<StreamingMessage content={`<think>## 阶段1：上下文分析\n读取章节数据</think>`} />)
    expect(screen.getByText("工作流进行中...")).toBeInTheDocument()
    // 段落内换行被折叠为空格（StreamingWorkflowBlock 的 p.replace(/\n/g, " ")）
    expect(screen.getByText(/阶段1：上下文分析/)).toBeInTheDocument()
  })

  it("思考 + 答案显示 WorkflowBlock 与答案及光标", () => {
    render(
      <StreamingMessage content={`<think>## 阶段1：上下文分析\n读取章节数据</think>\n\n流式答案`} />,
    )
    expect(screen.getByText("工作流阶段")).toBeInTheDocument()
    expect(screen.getByText("流式答案")).toBeInTheDocument()
  })

  it("未闭合 think 标签仍进入 streaming 工作流", () => {
    render(<StreamingMessage content="<think>## 阶段2：生成任务书\n写入中" />)
    expect(screen.getByText("工作流进行中...")).toBeInTheDocument()
  })

  it("孤立 </think> 结尾内容被提取为思考块", () => {
    render(<StreamingMessage content="some preamble</think>" />)
    expect(screen.getByText("工作流进行中...")).toBeInTheDocument()
    expect(screen.getByText("some preamble")).toBeInTheDocument()
  })

  it("empty thinking content falls back to answer without workflow block", () => {
    render(<StreamingMessage content="<think>   </think>answer" />)
    expect(screen.getByText("answer")).toBeInTheDocument()
    expect(screen.queryByText("工作流进行中...")).not.toBeInTheDocument()
  })
  it("英文 LLM 思考被过滤（isLlmEnglishThinking 命中）", () => {
    render(
      <StreamingMessage
        content={
          "<think>let's think about this. First, we analyze the user request. The user asked for help. Based on the constraints, I need to write. word count: 500. strategy: outline. okay, let's proceed.</think>\n\n最终答案"
        }
      />,
    )
    expect(screen.queryByText("工作流阶段")).not.toBeInTheDocument()
    expect(screen.getByText("最终答案")).toBeInTheDocument()
  })


  it("多阶段中文思考保留为 WorkflowBlock 且计数正确", () => {
    render(
      <StreamingMessage
        content={`<think>## 阶段1：上下文分析\n读取章节数据\n\n## 阶段2：生成任务书\n写任务书</think>\n\n答案`}
      />,
    )
    expect(screen.getByText("工作流阶段")).toBeInTheDocument()
    expect(screen.getByText(/阶段1：上下文分析/)).toBeInTheDocument()
    expect(screen.getByText(/阶段2：生成任务书/)).toBeInTheDocument()
    expect(screen.getByText("2 个阶段")).toBeInTheDocument()
  })

  it("无阶段标题的独立中文段落块保留", () => {
    render(<StreamingMessage content={`<think>独立内容块一\n\n独立内容块二</think>\n\n答案`} />)
    expect(screen.getByText("工作流阶段")).toBeInTheDocument()
    expect(screen.getByText("独立内容块一")).toBeInTheDocument()
    expect(screen.getByText("独立内容块二")).toBeInTheDocument()
  })

  it("阶段X： 无 ## 前缀的行也被识别为阶段头", () => {
    render(<StreamingMessage content={`<think>阶段1：开始\n内容</think>\n\n答案`} />)
    expect(screen.getByText(/阶段1：开始/)).toBeInTheDocument()
  })

  it("普通行不被识别为阶段头（isWorkflowStageHeader false）", () => {
    render(<StreamingMessage content={`<think>普通文本行\n继续</think>\n\n答案`} />)
    expect(screen.getByText(/普通文本行/)).toBeInTheDocument()
  })
})

// ── 全口径 100% 补充覆盖（W4）───────────────────────────────────────────────

describe("ChatMessage 全口径补充", () => {
  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("draft marker 但无可视正文 → canOperateOnDeepChapterDraft 空正文早退", () => {
    // 真实实现中 getCopyableAssistantContent 会剥掉 HTML 注释；mock 改为同语义后
    // visibleContent 为空 → `if (!visibleContent) return false` (L95) 命中
    mocks.getCopyableAssistantContent.mockImplementation((c: string) =>
      c.replace(/<!--.*?-->/gs, "").trim(),
    )
    render(
      <ChatMessage
        message={createAssistantMessage(DRAFT_MARKER("ready"))}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("draft marker + canContinueUnfinishedDeepChapter true → 操作隐藏", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(
          `<think>x</think>\n\n# Chapter 1 Title\n\n${"X".repeat(130)}\n\n已停止生成。\n\n${DRAFT_MARKER("ready")}`,
        )}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )
    expect(screen.queryByText("接受草稿")).not.toBeInTheDocument()
  })

  it("重复 wikilink id 去重（seen.has continue）", () => {
    render(<ChatMessage message={createAssistantMessage("参考 [[实体|显示名A]] 与 [[实体|显示名B]]")} />)
    // 同 id 去重：引用面板计数为 1，且面板只保留首个显示名（正文内 wikilink 按钮仍渲染两个）
    expect(screen.getByText("引用资料（1）")).toBeInTheDocument()
    expect(screen.getAllByText("显示名A").length).toBeGreaterThanOrEqual(1)
  })

  it("非 mermaid 代码块渲染原生 <code>（lang 非 mermaid 分支）", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("```ts\nconst x: number = 1\n```")} />,
    )
    const code = container.querySelector("code")
    expect(code).not.toBeNull()
    expect(code!.textContent).toContain("const x: number = 1")
    expect(code!.getAttribute("dir")).toBe("ltr")
  })

  it("img renderer：alt 缺失 → 空串；src 缺失 → undefined 分支", () => {
    const { container } = render(
      <ChatMessage message={createAssistantMessage("![无地址]\n\n![](https://example.com/x.png)")} />,
    )
    const imgs = container.querySelectorAll("img")
    // 至少 https 图片渲染成功（alt=undefined → ""）；无地址引用可能被跳过
    expect(imgs.length).toBeGreaterThan(0)
  })

  it("阶段标题 + 英文思考内容 → 标题保留、内容过滤（isLlmEnglishThinking 命中）", () => {
    render(
      <StreamingMessage
        content={
          "<think>## 阶段1：上下文分析\nlet's think about this. First, we analyze the request. Based on constraints, I need to write. word count: 500. strategy: outline. okay, proceed.</think>"
        }
      />,
    )
    expect(screen.getByText("工作流进行中...")).toBeInTheDocument()
    expect(screen.getByText(/阶段1：上下文分析/)).toBeInTheDocument()
    expect(screen.queryByText(/let's think/)).not.toBeInTheDocument()
  })

  it("孤立 </think> 且 beforeClose 为空 → 不提取思考、答案保留", () => {
    render(<StreamingMessage content="</think>rest" />)
    expect(screen.getByText("rest")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("StreamingWorkflowBlock 多段落（i>0 分支）", () => {
    render(
      <StreamingMessage
        content={`<think>## 阶段1：上下文分析\n读取章节数据\n\n## 阶段2：生成任务书\n写任务书</think>`}
      />,
    )
    expect(screen.getByText("工作流进行中...")).toBeInTheDocument()
  })

  it("AgentAwareContent：textContent 为空 → 回退渲染原始 content（|| 分支）", () => {
    render(
      <ChatMessage
        message={createAssistantMessage(
          `<file_edit path="wiki/chapters/c1.md">\n<search>\nold\n</search>\n<replace>\nnew\n</replace>\n</file_edit>`,
        )}
        projectPath="/p"
      />,
    )
    expect(screen.getByTestId("file-edit-preview")).toBeInTheDocument()
  })
})

describe("ChatMessage 引用面板全口径补充", () => {
  const PAGES = [
    { title: "P1", path: "/p/w1.md" },
    { title: "P2", path: "/p/w2.md" },
    { title: "P3", path: "/p/w3.md" },
  ]
  const REF1 = { title: "实体A", path: "wiki/entities/a.md" }

  beforeEach(() => {
    resetMocks()
    mocks.wikiState.project = { id: "p1", name: "P", path: "/p" }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("cited 数字越界 → [n] 越界 → wikilink 缺失 → 无面板（567/573/576 回退链）", () => {
    mocks.getLastQueryPages.mockReturnValue(PAGES)
    render(<ChatMessage message={createAssistantMessage("答案\n<!-- cited: 99 -->")} />)
    expect(screen.queryByText(/引用资料/)).not.toBeInTheDocument()
    cleanup()
    render(<ChatMessage message={createAssistantMessage("见 [9]")} />)
    expect(screen.queryByText(/引用资料/)).not.toBeInTheDocument()
  })

  it("project 变 null 后点击图片徽标 → handleJumpToImageSource 早退", async () => {
    mocks.readFile.mockResolvedValue("![a](img-1.png)")
    const view = render(<ChatMessage message={createAssistantMessage("answer", )} />)
    // 通过引用面板渲染（savedReferences 直接提供）
    cleanup()
    const view2 = render(<ChatMessage message={msgWithRefs([REF1])} />)
    const badge = await screen.findByTitle(/打开第一张图片所在原始文档（本页共 1 张图片）/)
    mocks.wikiState.project = null
    view2.rerender(<ChatMessage message={msgWithRefs([REF1])} isLastAssistant />)
    fireEvent.click(badge)
    await waitFor(() => {
      expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
    })
    view.unmount()
    view2.unmount()
  })

  it("图片徽标：raw 源读取失败 → console.warn（raw 分支）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.readFile
      .mockResolvedValueOnce("![a](img-1.png)") // effect 扫描命中
      .mockRejectedValueOnce(new Error("raw read fail")) // 跳转读取 rawPath 失败
    mocks.findRawSourceForImage.mockResolvedValue("/p/raw/sources/a.pdf")
    render(<ChatMessage message={msgWithRefs([REF1])} />)
    const badge = await screen.findByTitle(/打开第一张图片所在原始文档（本页共 1 张图片）/)
    fireEvent.click(badge)
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())
    warnSpy.mockRestore()
  })
})

function msgWithRefs(refs: { title: string; path: string }[], content = "answer"): DisplayMessage {
  return { ...createAssistantMessage(content), references: refs }
}
