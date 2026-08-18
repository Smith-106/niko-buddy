// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — FrontmatterPanel 全口径 100%。
 * store 依赖 vi.mock（可写 state），lib 依赖（wiki-type-style / wiki-page-resolver /
 * path-utils）使用真实实现，参考 src/App.spec.tsx 的 vi.hoisted 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { FrontmatterPanel } from "./frontmatter-panel"
import type { FrontmatterValue } from "@/lib/frontmatter"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => {
  const wikiState: {
    project: { id: string; path: string } | null
    fileTree: FileNode[]
    setSelectedFile: ReturnType<typeof vi.fn>
  } = {
    project: { id: "p1", path: "/p/novel" },
    fileTree: [],
    setSelectedFile: vi.fn(),
  }
  return {
    wikiState,
    t: vi.fn((key: string) => key),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

// path-utils 顶层 import 了 @/commands/fs（fileExists），提供空模块避免 Tauri 依赖链
vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async () => false),
}))

function renderPanel(data: Record<string, FrontmatterValue>): ReturnType<typeof render> {
  return render(<FrontmatterPanel data={data} />)
}

const TREE: FileNode[] = [
  {
    name: "wiki",
    path: "/p/novel/wiki",
    is_dir: true,
    children: [
      {
        name: "entities",
        path: "/p/novel/wiki/entities",
        is_dir: true,
        children: [{ name: "dpao.md", path: "/p/novel/wiki/entities/dpao.md", is_dir: false }],
      },
    ],
  },
  {
    name: "raw",
    path: "/p/novel/raw",
    is_dir: true,
    children: [
      {
        name: "sources",
        path: "/p/novel/raw/sources",
        is_dir: true,
        children: [{ name: "report.pdf", path: "/p/novel/raw/sources/report.pdf", is_dir: false }],
      },
    ],
  },
]

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.wikiState.project = { id: "p1", path: "/p/novel" }
  mocks.wikiState.fileTree = TREE
})

describe("FrontmatterPanel", () => {
  it("空 data → 不渲染（hasContent 全假）", () => {
    const { container } = renderPanel({})
    expect(container.firstChild).toBeNull()
  })

  it("identity：title + type + created + tags 渲染", () => {
    renderPanel({
      title: "DPAO 协议",
      type: "entity",
      created: "2026-01-01",
      tags: ["核心", "协议"],
    })
    expect(screen.getByText("DPAO 协议")).toBeInTheDocument()
    expect(screen.getByText("Entity")).toBeInTheDocument()
    expect(screen.getByText("2026-01-01")).toBeInTheDocument()
    expect(screen.getByText("核心")).toBeInTheDocument()
    expect(screen.getByText("协议")).toBeInTheDocument()
  })

  it("空字符串 title/type 不渲染对应条目（stringValue 假分支）", () => {
    renderPanel({ title: "", type: "", created: "", tags: [], description: "" })
    expect(screen.queryByText("Entity")).not.toBeInTheDocument()
    expect(screen.queryByText("Page")).not.toBeInTheDocument()
  })

  it("description 与 origin 渲染", () => {
    renderPanel({ title: "T", description: "一段描述", origin: "来自某处" })
    expect(screen.getByText("一段描述")).toBeInTheDocument()
    expect(screen.getByText(/来自某处/)).toBeInTheDocument()
  })

  it("未知类型 → FALLBACK style（Page / Hash icon）", () => {
    renderPanel({ title: "T", type: "unknown-type" })
    expect(screen.getByText("Page")).toBeInTheDocument()
  })

  it("sources 已解析：卡片可点击导航 setSelectedFile", async () => {
    renderPanel({
      title: "T",
      sources: ["[[report.pdf|研究报告]]"],
    })
    const card = screen.getByRole("button", { name: /研究报告/ })
    expect(card).toBeInTheDocument()
    fireEvent.click(card)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/novel/raw/sources/report.pdf")
  })

  it("related 未解析：project 为 null 时 wikiRoot 为空 → 不可点击", () => {
    mocks.wikiState.project = null
    renderPanel({ title: "T", related: ["ghost.md"] })
    const chip = screen.getByRole("button", { name: /ghost\.md/ })
    expect(chip.title).toContain("未找到关联页面")
    fireEvent.click(chip)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("sources 未解析：不可点击并显示警示图标（project 为 null 分支）", () => {
    mocks.wikiState.project = null
    renderPanel({ title: "T", sources: ["missing.pdf"] })
    const card = screen.getByRole("button", { name: /missing\.pdf/ })
    expect(card.title).toContain("未在 raw/sources/ 中找到")
    fireEvent.click(card)
    expect(mocks.wikiState.setSelectedFile).not.toHaveBeenCalled()
  })

  it("related 已解析：芯片可点击导航；未解析显示警示", async () => {
    renderPanel({
      title: "T",
      related: ["[[dpao|DPAO 页]]", "[[ghost|幽灵]]"],
    })
    const resolved = screen.getByRole("button", { name: /DPAO 页/ })
    fireEvent.click(resolved)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/novel/wiki/entities/dpao.md")

    const unresolved = screen.getByRole("button", { name: /幽灵/ })
    expect(unresolved.title).toContain("未找到关联页面")
    fireEvent.click(unresolved)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledTimes(1)
  })

  it("extras：排除 TOP_LEVEL_KEYS/空数组/空串，数组 join，普通值展示", () => {
    renderPanel({
      title: "T",
      type: "entity",
      tags: [],
      created: "",
      description: "",
      sources: [],
      related: [],
      origin: "",
      chapter_number: "1",
      chapter_status: "draft",
      outline_type: "3-act",
      customKey: "自定义值",
      listKey: ["a", "b"],
      emptyList: [],
      emptyStr: "",
    })
    expect(screen.getByText("更多")).toBeInTheDocument()
    expect(screen.getByText("自定义值")).toBeInTheDocument()
    expect(screen.getByText("a, b")).toBeInTheDocument()
    // 排除的 key 不展示
    expect(screen.queryByText("chapter_number:")).not.toBeInTheDocument()
    expect(screen.queryByText("emptyList:")).not.toBeInTheDocument()
  })

  it("extras 数组/普通值渲染（Array.isArray 两分支）+ 数字值", () => {
    renderPanel({ title: "T", num: "123", arr: ["x"] })
    expect(screen.getByText("x")).toBeInTheDocument()
    expect(screen.getByText("123")).toBeInTheDocument()
  })

  it("hasIdentity 各来源：仅 tags 或仅 created 时仍渲染", () => {
    renderPanel({ tags: ["only-tag"] })
    expect(screen.getByText("only-tag")).toBeInTheDocument()
  })

  it("iconForSource 覆盖各扩展名分支", () => {
    const sources = [
      "doc.pdf",
      "sheet.xlsx",
      "data.json",
      "code.py",
      "pic.png",
      "clip.mp4",
      "audio.mp3",
      "note.md",
      "misc.bin",
      "noext",
    ]
    renderPanel({ title: "T", sources })
    for (const name of sources) {
      expect(screen.getByTitle(`未在 raw/sources/ 中找到资料：${name}`)).toBeInTheDocument()
    }
  })

  it("stringValue：数字值（typeof 假分支）与纯空白字符串", () => {
    renderPanel({ title: 123 as unknown as string, type: "   " })
    // 123 本身真值 → hasIdentity 仍为 true；title 不渲染；type 空白 → 无标签
    expect(screen.queryByText("123")).not.toBeInTheDocument()
    expect(screen.queryByText("Page")).not.toBeInTheDocument()
  })

  it("arrayValue：非数组 tags → []，混合数组过滤非字符串与空白", () => {
    renderPanel({ title: "T", tags: ["a", "  ", 5 as unknown as string, "b"] })
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
    expect(screen.queryByText("5")).not.toBeInTheDocument()
  })

  it("related 与 sources 同时存在时 hasRelations 渲染", () => {
    renderPanel({
      title: "T",
      sources: ["missing.pdf"],
      related: ["missing2"],
    })
    expect(screen.getByText("资料")).toBeInTheDocument()
    expect(screen.getByText("关联")).toBeInTheDocument()
  })

  it("sources 为数组但为空 → 不渲染资料区块（hasRelations 假分支）", () => {
    renderPanel({ title: "T", sources: [], related: [] })
    expect(screen.queryByText("资料")).not.toBeInTheDocument()
    expect(screen.queryByText("关联")).not.toBeInTheDocument()
  })
})
