// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { WikiReader } from "./wiki-reader"

const mocks = vi.hoisted(() => {
  const state: {
    project: { id: string; name: string; path: string } | null
    fileTree: unknown[]
    setSelectedFile: (path: string | null) => void
  } = {
    project: null,
    fileTree: [],
    setSelectedFile: vi.fn((path: string | null) => {
      state.selectedFile = path
    }),
    selectedFile: null as string | null,
  }
  return {
    state,
    resolveMarkdownImageSrc: vi.fn((src: string) => `resolved:${src}`),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: mocks.resolveMarkdownImageSrc,
}))

const ENGLISH_BODY = [
  "# 标题一",
  "## 标题二",
  "### 标题三",
  "#### 标题四",
  "",
  "段落文本。",
  "",
  "- 无序项甲",
  "- 无序项乙",
  "",
  "1. 有序项甲",
  "2. 有序项乙",
  "",
  "> 引用内容",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 甲 | 乙 |",
  "",
  "[[目标页面]]",
  "",
  "[[不存在页面]]",
  "",
  "[外部链接](https://example.com)",
  "",
  "[坏链接](#%E0%A4%A)",
  "",
  "![图片说明](img.png)",
  "",
  "```js",
  "const x = 1",
  "```",
  "",
  "```mermaid",
  "graph TD;",
  "  A-->B;",
  "```",
  "",
  "行内 `code` 片段",
].join("\n")

describe("WikiReader", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDomGlobals()
    mocks.state.project = null
    mocks.state.fileTree = []
    mocks.state.selectedFile = null
    mocks.resolveMarkdownImageSrc.mockImplementation((src: string) => `resolved:${src}`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it("渲染全量 markdown 结构：标题/段落/列表/引用/表格/代码块/图片/链接", () => {
    render(<WikiReader body={ENGLISH_BODY} />)

    expect(screen.getByText("标题一", { selector: "h1" })).toBeInTheDocument()
    expect(screen.getByText("标题二", { selector: "h2" })).toBeInTheDocument()
    expect(screen.getByText("标题三", { selector: "h3" })).toBeInTheDocument()
    expect(screen.getByText("标题四", { selector: "h4" })).toBeInTheDocument()
    expect(screen.getByText("段落文本。")).toBeInTheDocument()
    expect(screen.getByText("无序项甲")).toBeInTheDocument()
    expect(screen.getByText("有序项甲")).toBeInTheDocument()
    expect(screen.getByText("引用内容")).toBeInTheDocument()
    expect(screen.getByText("甲", { selector: "td" })).toBeInTheDocument()
    expect(screen.getByText("列A", { selector: "th" })).toBeInTheDocument()
    expect(screen.getByText("const x = 1", { selector: "code" })).toBeInTheDocument()
    // mermaid 块：react-markdown v10 将 code renderer 元素作为 pre children，
    // unwrapMermaidPre 恒为 null → MermaidDiagram 真实渲染在 pre 内（jsdom 占位符）
    expect(screen.getByText("Diagram")).toBeInTheDocument()
    expect(document.querySelectorAll("pre")).toHaveLength(2)
  })

  it("无项目时：wikilink 点击被拦截但 resolve 跳过（wikiRoot 为空）", () => {
    render(<WikiReader body="[[目标页面]]" />)
    const link = screen.getByText("目标页面").closest("a")
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toContain("#")
    fireEvent.click(link as HTMLAnchorElement)
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("有项目且命中 wikilink：resolveRelatedSlug 后 setSelectedFile；未命中不调用", () => {
    mocks.state.project = { id: "p1", name: "Book", path: "/p" }
    mocks.state.fileTree = [
      {
        is_dir: false,
        name: "目标页面.md",
        path: "/p/wiki/目标页面.md",
      },
    ]
    render(<WikiReader body="[[目标页面]] 与 [[不存在页面]]" />)
    const hit = screen.getByText("目标页面").closest("a")
    fireEvent.click(hit as HTMLAnchorElement)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/wiki/目标页面.md")

    const miss = screen.getByText("不存在页面").closest("a")
    fireEvent.click(miss as HTMLAnchorElement)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledTimes(1)
  })

  it("外部链接不拦截（href 非 # 前缀）", () => {
    render(<WikiReader body="[外部链接](https://example.com)" />)
    const link = screen.getByText("外部链接").closest("a")
    expect(link?.getAttribute("href")).toBe("https://example.com")
    fireEvent.click(link as HTMLAnchorElement)
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("decodeURIComponent 抛错时走 catch 分支（非法百分号编码）", () => {
    mocks.state.project = { id: "p1", name: "Book", path: "/p" }
    render(<WikiReader body="[坏链接](#%E0%A4%A)" />)
    const link = screen.getByText("坏链接").closest("a")
    fireEvent.click(link as HTMLAnchorElement)
    // 解码失败 → 用原始片段，resolveRelatedSlug 找不到 → 不 setSelectedFile
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("图片：resolveMarkdownImageSrc 转换 src + data-mdsrc 保留原文", () => {
    render(<WikiReader body="![图片说明](img.png)" />)
    const img = screen.getByAltText("图片说明") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("resolved:img.png")
    expect(img.getAttribute("data-mdsrc")).toBe("img.png")
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("img.png", null)
  })

  it("阿拉伯语正文 → dir=rtl 且 lang=ar", () => {
    render(<WikiReader body="مرحبا بالعالم" />)
    const container = document.querySelector("[dir]")
    expect(container?.getAttribute("dir")).toBe("rtl")
    expect(container?.getAttribute("lang")).toBe("ar")
  })

  it("空 href 链接：h || undefined 兜底移除 href 属性", () => {
    render(<WikiReader body="[空链接]()" />)
    const link = screen.getByText("空链接").closest("a")
    expect(link?.hasAttribute("href")).toBe(false)
  })

  it("英语正文 → dir=ltr", () => {
    render(<WikiReader body="Hello world" />)
    const container = document.querySelector("[dir]")
    expect(container?.getAttribute("dir")).toBe("ltr")
  })

  it("空 src 图片：src 属性缺失但 data-mdsrc 保留空串（react-markdown 恒传 string）", () => {
    render(<WikiReader body={"![空]()"} />)
    const img = screen.getByAltText("空") as HTMLImageElement
    expect(img.getAttribute("data-mdsrc")).toBe("")
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("", null)
  })

  it("无 alt 图片：alt 兜底空串（alt 恒为 string）", () => {
    render(<WikiReader body="![](pic.png)" />)
    const img = document.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("alt")).toBe("")
    expect(mocks.resolveMarkdownImageSrc).toHaveBeenCalledWith("pic.png", null)
  })

  it("code 无 className 的内联代码：className 兜底样式", () => {
    render(<WikiReader body={"行内 `x` 代码"} />)
    const inline = screen.getByText("x")
    expect(inline.className).toContain("rounded")
    expect(inline.getAttribute("dir")).toBe("ltr")
  })
})
