import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildDismantlingAnalysisPrompt,
  buildDismantlingReferenceDirective,
  buildDismantlingWebResearchPrompt,
  extractDismantlingChapterNumber,
  extractStructureMemoryFromAnalysis,
  getDismantlingLibraryPath,
  loadDismantlingLibrary,
  normalizeDismantlingLibrary,
  saveDismantlingLibrary,
  selectNextDismantlingBatch,
  shouldReadDismantlingOriginalFile,
  splitDismantlingTextIntoChapters,
  type DismantlingProject,
} from "./dismantling"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
}))
vi.mock("@/commands/fs", () => ({
  fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFile: (...args: unknown[]) => fsMocks.writeFile(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
}))

describe("dismantling library", () => {
  it("stores dismantling data in an isolated project cache path", () => {
    expect(getDismantlingLibraryPath("E:/Novel")).toBe("E:/Novel/.qmai/dismantling/library.json")
  })

  it("splits imported text into ordered chapters without writing to novel memory", () => {
    const chapters = splitDismantlingTextIntoChapters(`第一章 开局
主角遭遇危机。

第二章 反击
主角开始行动。`)

    expect(chapters).toHaveLength(2)
    expect(chapters[0]).toMatchObject({ chapterNumber: 1, title: "第一章 开局" })
    expect(chapters[1]).toMatchObject({ chapterNumber: 2, title: "第二章 反击" })
    expect(chapters.map((item) => item.content).join("\n")).not.toContain("wiki/chapters")
  })

  it("auto-detects chapter headings from a full imported novel with volumes and full-width digits", () => {
    const chapters = splitDismantlingTextIntoChapters(`大奉打更人

正文卷　第１章　税银案
许七安醒来，发现自己身处牢中。

第一卷 京城风云 第2章 夜审
牢门打开，火光照进来。

  第三章 破局
他终于抓住了第一个破绽。`)

    expect(chapters).toHaveLength(3)
    expect(chapters.map((chapter) => chapter.chapterNumber)).toEqual([1, 2, 3])
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "正文卷 第1章 税银案",
      "第一卷 京城风云 第2章 夜审",
      "第三章 破局",
    ])
  })

  it("auto-detects chapters when imported document extraction keeps headings inside paragraphs", () => {
    const chapters = splitDismantlingTextIntoChapters(
      "书名 大奉打更人  第1章 大奉打更人 许七安睁开眼。  第2章 税银案 夜色压下来。  第3章 打更人 铜锣声响起。",
    )

    expect(chapters).toHaveLength(3)
    expect(chapters.map((chapter) => chapter.chapterNumber)).toEqual([1, 2, 3])
    expect(chapters[0].title).toBe("第1章 大奉打更人")
    expect(chapters[1].content).toContain("夜色压下来")
  })

  it("extracts a reader-style full novel text into its complete chapter catalog", () => {
    const chapters = splitDismantlingTextIntoChapters(`大奉打更人

第一卷 京察风云

第0001章 税银案
许七安睁开眼，发现自己身处牢中。

第0002章 牢中破局
他听见远处传来铜锣声，心里有了判断。

第0003章 打更人
火把照亮甬道，新的危机已经逼近。`)

    expect(chapters).toHaveLength(3)
    expect(chapters.map((chapter) => chapter.chapterNumber)).toEqual([1, 2, 3])
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第0001章 税银案",
      "第0002章 牢中破局",
      "第0003章 打更人",
    ])
  })

  it("falls back to reading the original imported book when preprocessing skips text files", () => {
    expect(shouldReadDismantlingOriginalFile("no preprocessing needed")).toBe(true)
    expect(shouldReadDismantlingOriginalFile("  NO PREPROCESSING NEEDED  ")).toBe(true)
    expect(shouldReadDismantlingOriginalFile("第1章 正文")).toBe(false)
  })

  it("deduplicates dismantling projects with the same normalized title", () => {
    const library = normalizeDismantlingLibrary({
      projects: [
        makeProject("a", "大奉打更人", 3),
        makeProject("b", " 大奉打更人.txt ", 1),
        makeProject("c", "小说", 7),
      ],
    })

    expect(library.projects.map((item) => item.id)).toEqual(["a", "c"])
    expect(library.selectedProjectId).toBe("a")
  })

  it("selects only the requested pending chapters for one batch", () => {
    const project: DismantlingProject = {
      id: "book-1",
      title: "示例作品",
      createdAt: 1,
      updatedAt: 1,
      chapters: [
        { id: "c1", chapterNumber: 1, title: "第一章", content: "一", status: "pending" },
        { id: "c2", chapterNumber: 2, title: "第二章", content: "二", status: "done" },
        { id: "c3", chapterNumber: 3, title: "第三章", content: "三", status: "pending" },
      ],
      analyses: [],
      structureMemory: [],
    }

    expect(selectNextDismantlingBatch(project, { selectedChapterIds: ["c1", "c3"], batchSize: 1 }).map((item) => item.id)).toEqual(["c1"])
    expect(selectNextDismantlingBatch(project, { selectedChapterIds: ["c1", "c3"], batchSize: 5 }).map((item) => item.id)).toEqual(["c1", "c3"])
  })

  it("builds an analysis prompt that keeps dismantling memory separate from current novel facts", () => {
    const prompt = buildDismantlingAnalysisPrompt({
      projectTitle: "参考作品",
      chapters: [
        { id: "c1", chapterNumber: 1, title: "第一章", content: "主角被追杀，反手设局。", status: "pending" },
      ],
    })

    expect(prompt).toContain("独立拆文记忆库")
    expect(prompt).toContain("不得把原作人物、设定、剧情当成当前小说事实")
    expect(prompt).toContain("只输出结构化写法分析")
    expect(prompt).toContain("章节结构")
    expect(prompt).toContain("爽点")
    expect(prompt).toContain("结尾钩子")
  })

  it("builds a web research prompt for hot-topic and webpage dismantling without mixing novel memory", () => {
    const prompt = buildDismantlingWebResearchPrompt({
      projectTitle: "参考作品",
      userRequest: "分析这个榜单的热门套路",
      webResearchContext: "## 联网研究资料\n榜单作品都使用强冲突开篇。",
    })

    expect(prompt).toContain("网页热门分析")
    expect(prompt).toContain("参考作品")
    expect(prompt).toContain("分析这个榜单的热门套路")
    expect(prompt).toContain("## 联网研究资料")
    expect(prompt).toContain("只写入独立拆文记忆库")
    expect(prompt).toContain("不要写入当前小说事实")
  })

  it("builds a chat directive that references structure but forbids copying original content", () => {
    const directive = buildDismantlingReferenceDirective({
      title: "参考作品",
      structureMemory: [
        "前三章节奏：开局危机、第二章反击、第三章扩大代价。",
        "结尾钩子：每章末尾留下立即行动压力。",
      ],
    })

    expect(directive).toContain("参考拆文结构")
    expect(directive).toContain("不得复用原作人物")
    expect(directive).toContain("不得复用原作剧情")
    expect(directive).toContain("只学习节奏、冲突推进、爽点安排和章节钩子")
  })

  it("builds an empty directive when there is no structure memory", () => {
    expect(buildDismantlingReferenceDirective({ title: "参考作品", structureMemory: [] })).toBe("")
  })
})

describe("dismantling library persistence", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset()
    fsMocks.createDirectory.mockReset()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
  })

  it("loadDismantlingLibrary returns the default when the file is missing or corrupt", async () => {
    const lib = await loadDismantlingLibrary("/p")
    expect(lib).toEqual({ version: 1, projects: [], selectedProjectId: null })

    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockRejectedValue(new Error("corrupt"))
    const lib2 = await loadDismantlingLibrary("/p")
    expect(lib2).toEqual({ version: 1, projects: [], selectedProjectId: null })
  })

  it("loadDismantlingLibrary parses and normalizes a persisted library", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      selectedProjectId: "b",
      projects: [
        { id: "a", title: "作品甲", createdAt: 1, updatedAt: 1, chapters: [], analyses: [], structureMemory: [], useInChat: true },
        { id: "b", title: "作品乙", createdAt: 2, updatedAt: 2, chapters: [], analyses: [], structureMemory: [] },
      ],
    }))
    const lib = await loadDismantlingLibrary("/p")
    expect(lib.projects.map(p => p.id)).toEqual(["a", "b"])
    expect(lib.selectedProjectId).toBe("b")
    expect(lib.projects[0].useInChat).toBe(true)
  })

  it("saveDismantlingLibrary tolerates createDirectory failures and writes normalized json", async () => {
    fsMocks.createDirectory.mockRejectedValue(new Error("mkdir fail"))
    await saveDismantlingLibrary("/p", { version: 1, projects: [], selectedProjectId: null })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    const [path, raw] = fsMocks.writeFile.mock.calls[0]
    expect(path).toBe("/p/.qmai/dismantling/library.json")
    expect(JSON.parse(String(raw)).version).toBe(1)
  })
})

describe("dismantling normalization fallbacks", () => {
  it("fills fallbacks for minimal projects, chapters and analyses", () => {
    const lib = normalizeDismantlingLibrary({
      projects: [
        {
          id: "p1",
          createdAt: "not-a-date",
          updatedAt: 0,
          chapters: [{}, { id: "keep", chapterNumber: 5, title: "已有", content: "正文", status: "failed", error: "x" }],
          analyses: [{}, { id: "an1", chapterIds: ["a"], title: "已有分析", createdAt: 7, markdown: "m", structureMemory: ["mem"] }],
          structureMemory: ["有用", "", null as never],
          useInChat: true,
        },
      ],
    })
    const project = lib.projects[0]
    expect(project.title).toBe("未命名拆文作品")
    expect(project.useInChat).toBe(true)
    expect(project.chapters[0]).toMatchObject({ id: "chapter-1", chapterNumber: 1, title: "第1章", content: "", status: "pending" })
    expect(project.chapters[1].id).toBe("keep")
    expect(project.chapters[1].status).toBe("failed")
    expect(project.analyses[0].id).toMatch(/^analysis-/)
    expect(project.analyses[0].title).toBe("拆文结果")
    expect(project.analyses[0].chapterIds).toEqual([])
    expect(project.analyses[1].chapterIds).toEqual(["a"])
    expect(project.structureMemory).toEqual(["有用"])
  })

  it("resolves selectedProjectId against the surviving projects", () => {
    const lib = normalizeDismantlingLibrary({
      selectedProjectId: "ghost",
      projects: [makeProject("a", "作品A", 1)],
    })
    expect(lib.selectedProjectId).toBe("a")

    const empty = normalizeDismantlingLibrary({})
    expect(empty.projects).toEqual([])
    expect(empty.selectedProjectId).toBeNull()

    // 标题归一化为空的项目被保留（key 为空时不参与去重）
    const blankTitle = normalizeDismantlingLibrary({ projects: [{ id: "x", title: "   " }] })
    expect(blankTitle.projects.map(p => p.id)).toEqual(["x"])

    // 无 id 的项目回退为 dismantling-<timestamp>
    const noId = normalizeDismantlingLibrary({ projects: [{ title: "无ID作品" }] })
    expect(noId.projects[0].id).toMatch(/^dismantling-\d+$/)
  })
})

describe("dismantling chapter split edge cases", () => {
  it("returns empty for blank text and a single chapter when no markers exist", () => {
    expect(splitDismantlingTextIntoChapters("   ")).toEqual([])
    const single = splitDismantlingTextIntoChapters("纯文本没有章节标记")
    expect(single).toHaveLength(1)
    expect(single[0]).toMatchObject({ id: "chapter-001", chapterNumber: 1, title: "第1章" })
    expect(single[0].content).toContain("纯文本没有章节标记")
  })

  it("parses Chinese chapter numbers with 十/百/千/万 units", () => {
    const chapters = splitDismantlingTextIntoChapters(`第十章 开端
正文A。

第一百章 中段
正文B。

第一千章 后期
正文C。

第一万章 终局
正文D。`)
    expect(chapters.map(c => c.chapterNumber)).toEqual([10, 100, 1000, 10000])
  })

  it("handles 万 without a leading digit and zero-valued chapter numbers", () => {
    // 万 前无数值 → (0 || 1) * 10000
    const wan = splitDismantlingTextIntoChapters("第万章 巨卷\n正文。")
    expect(wan[0].chapterNumber).toBe(10000)
    // 〇/零 解析为 0 → 章号不可用，回退到序号
    const zero = splitDismantlingTextIntoChapters("第〇章 序\n正文。\n\n第二章 正式\n正文。")
    expect(zero.map(c => c.chapterNumber)).toEqual([1, 2])
  })

  it("keeps the full heading as title when a long first line carries a volume prefix before the marker", () => {
    // 首行 > 100 字符 → 跳过 fast path 进入 splitInlineDismantlingChapter;
    // 此时 marker 不在段首, markerMatch[1] 非空 → 命中 `|| 第N章` 的 left 臂。
    const longHeading =
      "第一卷 京城风云 第2章 夜审 这一章的开头延续上章结尾的紧张气氛，许七安沿着阴暗的巷道快步前行，" +
      "脚步声在石板上回荡，远处传来低沉的更鼓之声与犬吠，他心中暗自盘算着今夜的局面，也留意着巷口巡逻的更夫动向，" +
      "同时回想昨日与人约定的时辰与暗号。"
    const chapters = splitDismantlingTextIntoChapters(`${longHeading}\n正文继续。`)
    expect(chapters.map(c => c.chapterNumber)).toEqual([2])
    expect(chapters[0].title).toBe("第一卷 京城风云 第2章 夜审")
    expect(chapters[0].content).toContain("正文继续")
  })

  it("extracts chapter numbers from English markers and returns null otherwise", () => {
    expect(extractDismantlingChapterNumber("chapter 12 标题")).toBe(12)
    expect(extractDismantlingChapterNumber("Chapter 7")).toBe(7)
    expect(extractDismantlingChapterNumber("普通文本")).toBeNull()
  })

  it("extracts structure memory from the dedicated section or the raw markdown", () => {
    const withSection = extractStructureMemoryFromAnalysis(`## 章节拆解
...
## 可复用结构记忆
- 开局三章节奏：危机-反击-代价
1. 每章末尾留钩子

短`)
    expect(withSection).toContain("开局三章节奏：危机-反击-代价")
    expect(withSection).toContain("每章末尾留钩子")
    // 过短行被过滤
    expect(withSection.some(line => line.length < 6)).toBe(false)

    const withoutSection = extractStructureMemoryFromAnalysis("## 普通章节\n- 没有记忆段的行\n")
    expect(withoutSection).toContain("没有记忆段的行")
  })

  it("caps batch size and excludes selected-but-done chapters", () => {
    const project: DismantlingProject = {
      id: "b1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      chapters: [
        { id: "c3", chapterNumber: 3, title: "三", content: "", status: "pending" },
        { id: "c2", chapterNumber: 2, title: "二", content: "", status: "done" },
        { id: "c1", chapterNumber: 1, title: "一", content: "", status: "pending" },
      ],
      analyses: [],
      structureMemory: [],
    }
    // done 章节即使被选中也被排除；按章节号排序；batchSize 0 → 1
    expect(selectNextDismantlingBatch(project, { selectedChapterIds: ["c1", "c2", "c3"], batchSize: 0 }).map(c => c.id)).toEqual(["c1"])
    expect(selectNextDismantlingBatch(project, { selectedChapterIds: ["c1", "c3"], batchSize: 99 }).map(c => c.id)).toEqual(["c1", "c3"])
  })
})

function makeProject(id: string, title: string, chapterCount: number): DismantlingProject {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, index) => ({
      id: `${id}-${index + 1}`,
      chapterNumber: index + 1,
      title: `第${index + 1}章`,
      content: "内容",
      status: "pending",
    })),
    analyses: [],
    structureMemory: [],
  }
}
