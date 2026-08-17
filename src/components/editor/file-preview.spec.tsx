// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { FilePreview } from "./file-preview"

interface ProjectLike {
  id: string
  name: string
  path: string
}

interface WikiStateLike {
  project: ProjectLike | null
  pendingScrollImageSrc: string | null
  setPendingScrollImageSrc: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    project: null,
    pendingScrollImageSrc: null,
    setPendingScrollImageSrc: vi.fn(),
  }
  return {
    state,
    getFileCategory: vi.fn(() => "text"),
    getCodeLanguage: vi.fn(() => "txt"),
    getFileName: vi.fn((p: string) => p.split("/").pop() ?? p),
    resolveMarkdownImageSrc: vi.fn((src: string, projectPath: string | null) => `resolved:${projectPath ?? "none"}:${src}`),
    detectLanguage: vi.fn(() => "zh"),
    getHtmlLang: vi.fn(() => "zh"),
    getTextDirection: vi.fn(() => "ltr"),
    parseFrontmatter: vi.fn((content: string) => ({ frontmatter: null, body: content, rawBlock: "" })),
    isTauri: vi.fn(() => false),
    convertFileSrc: vi.fn((p: string) => `asset://${p}`),
  }
})

vi.mock("@/lib/file-types", () => ({
  getFileCategory: mocks.getFileCategory,
  getCodeLanguage: mocks.getCodeLanguage,
}))

vi.mock("@/lib/path-utils", () => ({
  getFileName: mocks.getFileName,
}))

vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: mocks.resolveMarkdownImageSrc,
}))

vi.mock("@/lib/detect-language", () => ({
  detectLanguage: mocks.detectLanguage,
}))

vi.mock("@/lib/language-metadata", () => ({
  getHtmlLang: mocks.getHtmlLang,
  getTextDirection: mocks.getTextDirection,
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: mocks.parseFrontmatter,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}))

vi.mock("@/components/editor/frontmatter-panel", () => ({
  FrontmatterPanel: () => <div data-testid="frontmatter-panel" />,
}))

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
}))

vi.mock("@/components/mermaid-diagram", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/components/mermaid-diagram")>()
  return {
    ...orig,
    MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid" data-code={code} />,
  }
})

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("FilePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = null
    mocks.state.pendingScrollImageSrc = null
    mocks.getFileCategory.mockReturnValue("text")
    mocks.getCodeLanguage.mockReturnValue("txt")
    mocks.parseFrontmatter.mockImplementation((content: string) => ({
      frontmatter: null,
      body: content,
      rawBlock: "",
    }))
    mocks.isTauri.mockReturnValue(false)
    if (typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(HTMLImageElement.prototype, "complete")
  })

  it("image：非 Tauri 直接用 filePath", async () => {
    mocks.getFileCategory.mockReturnValue("image")
    render(<FilePreview filePath="/p/cover.png" textContent="" />)

    await flushAsync()
    const img = screen.getByRole("img") as HTMLImageElement
    expect(img.src).toContain("/p/cover.png")
    expect(img.alt).toBe("cover.png")
    expect(screen.getByText("/p/cover.png")).toBeTruthy()
  })

  it("image：Tauri 环境转 asset URL", async () => {
    mocks.getFileCategory.mockReturnValue("image")
    mocks.isTauri.mockReturnValue(true)
    render(<FilePreview filePath="/p/cover.png" textContent="" />)
    await flushAsync()

    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/p/cover.png")
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("asset:///p/cover.png")
  })

  it("video：渲染 video 与字幕 track", async () => {
    mocks.getFileCategory.mockReturnValue("video")
    render(<FilePreview filePath="/p/clip.mp4" textContent="" />)
    await flushAsync()

    const video = screen.getByText("/p/clip.mp4").parentElement?.querySelector("video") as HTMLVideoElement
    expect(video).toBeTruthy()
    expect(video.src).toContain("/p/clip.mp4")
    expect(video.controls).toBe(true)
    expect(document.querySelector("track")?.getAttribute("label")).toBe("clip.mp4")
  })

  it("video：Tauri 环境转 asset URL", async () => {
    mocks.getFileCategory.mockReturnValue("video")
    mocks.isTauri.mockReturnValue(true)
    render(<FilePreview filePath="/p/clip.mp4" textContent="" />)
    await flushAsync()

    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/p/clip.mp4")
    expect(document.querySelector("video")?.getAttribute("src")).toContain("asset:///p/clip.mp4")
  })

  it("audio：渲染 audio 与文件名", async () => {
    mocks.getFileCategory.mockReturnValue("audio")
    render(<FilePreview filePath="/p/song.mp3" textContent="" />)
    await flushAsync()

    const audio = document.querySelector("audio") as HTMLAudioElement
    expect(audio).toBeTruthy()
    expect(audio.src).toContain("/p/song.mp3")
    expect(screen.getByText("song.mp3")).toBeTruthy()
  })

  it("audio：Tauri 环境转 asset URL", async () => {
    mocks.getFileCategory.mockReturnValue("audio")
    mocks.isTauri.mockReturnValue(true)
    render(<FilePreview filePath="/p/song.mp3" textContent="" />)
    await flushAsync()

    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/p/song.mp3")
    expect(document.querySelector("audio")?.getAttribute("src")).toContain("asset:///p/song.mp3")
  })

  it("pdf：TextPreview 使用 extracted 标签", () => {
    mocks.getFileCategory.mockReturnValue("pdf")
    render(<FilePreview filePath="/p/doc.pdf" textContent="# hello" />)
    expect(screen.getByText("PDF (extracted text)")).toBeTruthy()
    expect(screen.getByText("hello")).toBeTruthy()
  })

  it("text：TextPreview 使用 Text 标签", () => {
    mocks.getFileCategory.mockReturnValue("text")
    render(<FilePreview filePath="/p/note.txt" textContent="plain" />)
    expect(screen.getByText("Text")).toBeTruthy()
    expect(screen.getByText("plain")).toBeTruthy()
  })

  it("code：CodePreview 显示语言徽标", () => {
    mocks.getFileCategory.mockReturnValue("code")
    mocks.getCodeLanguage.mockReturnValue("typescript")
    render(<FilePreview filePath="/p/app.ts" textContent="const x = 1" />)
    expect(screen.getByText("typescript")).toBeTruthy()
    expect(screen.getByText("const x = 1")).toBeTruthy()
  })

  it("data：走 CodePreview 渲染", () => {
    mocks.getFileCategory.mockReturnValue("data")
    render(<FilePreview filePath="/p/data.json" textContent='{"a":1}' />)
    expect(screen.getByText('{"a":1}')).toBeTruthy()
  })

  it("document：BinaryPlaceholder 使用 FileSpreadsheet 图标", () => {
    mocks.getFileCategory.mockReturnValue("document")
    render(<FilePreview filePath="/p/book.epub" textContent="" />)
    expect(screen.getByText("book.epub")).toBeTruthy()
    expect(screen.getByText("暂不支持预览该类型文件")).toBeTruthy()
    expect(document.querySelector(".lucide-file-spreadsheet")).toBeTruthy()
  })

  it("unknown 类别：走 default 分支，使用 FileQuestion 图标", () => {
    mocks.getFileCategory.mockReturnValue("unknown" as never)
    render(<FilePreview filePath="/p/weird.xyz" textContent="" />)
    expect(screen.getByText("weird.xyz")).toBeTruthy()
    expect(document.querySelector(".lucide-file-question-mark")).toBeTruthy()
  })

  it("未知类别（iconMap 外）→ default 分支 + iconMap 回退 FileQuestion 图标", () => {
    mocks.getFileCategory.mockReturnValue("banana" as never)
    render(<FilePreview filePath="/p/fruit.banana" textContent="" />)
    expect(screen.getByText("fruit.banana")).toBeTruthy()
    expect(screen.getByText("暂不支持预览该类型文件")).toBeTruthy()
    expect(document.querySelector(".lucide-file-question-mark")).toBeTruthy()
  })

  it("空 src 图片：resolve 收到空串（src 恒为 string 的守卫路径）", () => {
    render(<FilePreview filePath="/p/page.md" textContent={"![空]()"} />)
    const img = screen.getByAltText("空") as HTMLImageElement
    expect(img.getAttribute("data-mdsrc")).toBe("")
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("", null)
  })

  it("TextPreview 渲染 markdown：图片、表格、代码块、内联代码", () => {
    mocks.state.project = { id: "p1", name: "P", path: "/p" }
    const md = [
      "## 标题",
      "![图一](pic.png)",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
      "内联 `code` 文本",
    ].join("\n")
    render(<FilePreview filePath="/p/page.md" textContent={md} />)

    const img = screen.getByRole("img") as HTMLImageElement
    expect(img.getAttribute("data-mdsrc")).toBe("pic.png")
    expect(img.src).toContain("resolved:/p:pic.png")
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("pic.png", "/p")

    expect(screen.getByText("a")).toBeTruthy()
    expect(screen.getByText("1")).toBeTruthy()
    expect(document.querySelector("table")).toBeTruthy()
    expect(document.querySelector("thead")).toBeTruthy()
    expect(document.querySelector("th")).toBeTruthy()
    expect(document.querySelector("td")).toBeTruthy()

    expect(document.querySelector("pre")).toBeTruthy()
    expect(screen.getByText("const x = 1")).toBeTruthy()
    expect(document.querySelector("code[dir='ltr']")).toBeTruthy()
  })

  it("mermaid 代码块渲染 MermaidDiagram（code 渲染器 + pre 解包）", () => {
    const md = ["```mermaid", "graph TD; A-->B", "```"].join("\n")
    render(<FilePreview filePath="/p/g.md" textContent={md} />)
    const mermaid = screen.getByTestId("mermaid")
    expect(mermaid.getAttribute("data-code")).toBe("graph TD; A-->B")
  })

  it("frontmatter 存在时渲染 FrontmatterPanel", () => {
    mocks.parseFrontmatter.mockImplementation((content: string) => ({
      frontmatter: { title: "T" },
      body: content.replace(/^---[\s\S]*?---\s*/, ""),
      rawBlock: "---\ntitle: T\n---\n",
    }))
    render(<FilePreview filePath="/p/fm.md" textContent={"---\ntitle: T\n---\n正文"} />)
    expect(screen.getByTestId("frontmatter-panel")).toBeTruthy()
    expect(screen.getByText("正文")).toBeTruthy()
  })

  it("无 frontmatter 时不渲染 FrontmatterPanel", () => {
    render(<FilePreview filePath="/p/plain.md" textContent="body" />)
    expect(screen.queryByTestId("frontmatter-panel")).toBeNull()
  })

  it("pendingScrollImageSrc 命中：滚动高亮、监听 load、超时后移除高亮并清除", async () => {
    mocks.state.pendingScrollImageSrc = "pic.png"
    const md = "![图](pic.png)"
    render(<FilePreview filePath="/p/page.md" textContent={md} />)

    await flushAsync()
    const img = screen.getByRole("img") as HTMLImageElement
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(img.classList.contains("ring-2")).toBe(true)
    expect(mocks.state.setPendingScrollImageSrc).toHaveBeenCalledWith(null)

    // 手动触发 load → 平滑滚动并移除监听
    fireEvent.load(img)
    await flushAsync()
    expect(img.classList.contains("ring-2")).toBe(true)

    // 等待高亮超时移除
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900))
    })
    expect(img.classList.contains("ring-2")).toBe(false)
    expect(img.classList.contains("ring-primary")).toBe(false)
  })

  it("pendingScrollImageSrc 未命中任何图片时清除", async () => {
    mocks.state.pendingScrollImageSrc = "missing.png"
    render(<FilePreview filePath="/p/page.md" textContent="![图](pic.png)" />)
    await flushAsync()

    expect(mocks.state.setPendingScrollImageSrc).toHaveBeenCalledWith(null)
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it("pendingScrollImageSrc 为空时不做滚动处理", async () => {
    render(<FilePreview filePath="/p/page.md" textContent="![图](pic.png)" />)
    await flushAsync()
    expect(mocks.state.setPendingScrollImageSrc).not.toHaveBeenCalled()
  })

  it("pendingScrollImageSrc 命中且图片已加载完成时不挂载 load 监听", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    })
    mocks.state.pendingScrollImageSrc = "pic.png"
    render(<FilePreview filePath="/p/page.md" textContent="![图](pic.png)" />)
    await flushAsync()

    const img = screen.getByRole("img") as HTMLImageElement
    expect(img.classList.contains("ring-2")).toBe(true)
    // 无 load 监听也不影响超时移除高亮
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900))
    })
    expect(img.classList.contains("ring-2")).toBe(false)
  })

  it("无项目时图片解析传入 null", () => {
    render(<FilePreview filePath="/p/page.md" textContent="![图](pic.png)" />)
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("pic.png", null)
  })
})
