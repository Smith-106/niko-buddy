// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { ChapterDirectory, groupRowsByVolume } from "./chapter-directory"

const storeState = vi.hoisted(() => ({ project: { id: "p1", name: "p", path: "C:/proj" }, dataVersion: 1, setSelectedFile: vi.fn() }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return { ...actual, useWikiStore: (s: (x: typeof storeState) => unknown) => s(storeState) }
})
vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty", init: () => undefined }, useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o && typeof o.count === "number" ? `${k}#${o.count}` : k) }) }))

const rows = [
  { chapterNumber: -1, isOutline: true, title: "卷纲", wordCount: null, filePath: null },
  { chapterNumber: 1, isOutline: false, title: "开端：这是一个很长很长的章节标题用于悬浮预览", wordCount: 3000, filePath: "C:/proj/1.md" },
  { chapterNumber: 99, isOutline: false, title: "散章", wordCount: 100, filePath: null },
]
const vols = [{ volumeNumber: 1, title: "启程", summary: "", chapterRangeStart: 1, chapterRangeEnd: 10 }]

describe("groupRowsByVolume", () => {
  it("大纲轨分离+卷区间分组+区间外入未分卷", () => {
    const d = groupRowsByVolume(rows, vols)
    expect(d.outlines.map((r) => r.chapterNumber)).toEqual([-1])
    expect(d.volumes[0].meta?.volumeNumber).toBe(1)
    expect(d.volumes[0].rows.map((r) => r.chapterNumber)).toEqual([1])
    expect(d.volumes[1].meta).toBeNull()
  })
})

describe("ChapterDirectory", () => {
  afterEach(cleanup)
  const loader = async () => groupRowsByVolume(rows, vols)
  it("卷手风琴+大纲双轨+标题悬浮+禁拖拽", async () => {
    const { container } = render(<ChapterDirectory loader={loader} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-volume-1")).toBeTruthy())
    expect(screen.getByTestId("chapter-directory-outline-track")).toBeTruthy()
    expect(screen.getByTestId("chapter-directory-total").textContent).toBe("novel.chapterDirectory.total#3")
    expect(screen.getByTestId("chapter-directory-title-1").getAttribute("title")).toContain("很长很长的章节标题")
    expect(container.querySelector("[draggable]")).toBeNull()
    expect(container.innerHTML).not.toMatch(/dnd|sortable/i)
  })
})

// ── 覆盖率加深（增补：原有用例保留不动）───────────────────────────────────────
// 目标：filenameTitle/chapterDirectoryTitle 回退链、loadVolumeMetas、
// loadChapterDirectory 容错分支、组件无项目/加载/错误+重试/空态/行点击/取消分支。
import { act } from "@testing-library/react"
import {
  chapterDirectoryTitle,
  loadChapterDirectory,
  type ChapterDirectoryData,
  type ChapterDirectoryLoader,
} from "./chapter-directory"

const ioStubs = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  loadSnapshot: vi.fn(),
  findChapterFileByNumber: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  searchWiki: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listSnapshots: ioStubs.listSnapshots,
    loadSnapshot: ioStubs.loadSnapshot,
    findChapterFileByNumber: ioStubs.findChapterFileByNumber,
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists: ioStubs.fileExists, readFile: ioStubs.readFile }
})

vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>()
  return { ...actual, searchWiki: ioStubs.searchWiki }
})

describe("chapterDirectoryTitle — 标题回退链（纯函数）", () => {
  afterEach(cleanup)

  it("快照富标题优先（正文再富也不覆盖快照）", () => {
    expect(
      chapterDirectoryTitle("第5章 律师说没漏洞", "# 第6章 他人故事\n正文正文", "C:/x/第6章 他人故事.md"),
    ).toBe("第5章 律师说没漏洞")
  })

  it("快照裸标签 + 正文富 H1 → 取正文 H1", () => {
    expect(chapterDirectoryTitle("第5章", "# 第5章 律师说没漏洞\n正文正文", null)).toBe(
      "第5章 律师说没漏洞",
    )
  })

  it("快照裸标签 + frontmatter 富 title → 取 frontmatter title", () => {
    expect(chapterDirectoryTitle("第4章", "---\ntitle: 第4章 密谋\n---\n正文正文", null)).toBe(
      "第4章 密谋",
    )
  })

  it("快照空 + 富文件名 stem → 取文件名（反斜杠+大写扩展名）", () => {
    expect(chapterDirectoryTitle(null, null, "C:\\proj\\第8章 重逢.MD")).toBe("第8章 重逢")
  })

  it("裸文件名 stem 不算富标题 → null（禁止裸章名冒充）", () => {
    expect(chapterDirectoryTitle(null, "   ", "C:/proj/chapter-001.md")).toBeNull()
  })

  it("快照非空非富 + 无正文 → 原样返回快照（大纲轨不断链）", () => {
    expect(chapterDirectoryTitle("  卷纲-设定  ", null, null)).toBe("卷纲-设定")
  })

  it("快照非富 + 空白正文 → 返回快照（跳过解析）", () => {
    expect(chapterDirectoryTitle("普通标题", "   \n  ", null)).toBe("普通标题")
  })

  it("无标题正文 + 空回退 → 解析为空 → null（不造标题）", () => {
    expect(chapterDirectoryTitle("", "纯正文内容无标题", null)).toBeNull()
  })
})

describe("loadChapterDirectory — 只读装载容错", () => {
  afterEach(cleanup)

  const chapterFile = "C:/proj/chapters/chapter-001.md"
  const chapterContent = `# 第1章 开端\n${"正文".repeat(50)}`
  const volumeFile = "C:/proj/wiki/volume-001.md"
  const volumeContent = `---\nvolume_number: 1\ntitle: 启程\nchapter_range_start: 1\nchapter_range_end: 10\n---\n卷说明`

  function stubHappyPath() {
    ioStubs.listSnapshots.mockResolvedValue([1, -2])
    ioStubs.loadSnapshot.mockImplementation(async (_pp: unknown, n: unknown) => {
      if (n === 1) return { chapterTitle: "第1章 开端" }
      throw new Error("snapshot missing")
    })
    ioStubs.findChapterFileByNumber.mockImplementation(async (_pp: unknown, n: unknown) =>
      n === 1 ? chapterFile : null,
    )
    ioStubs.fileExists.mockImplementation(async (p: unknown) => p === chapterFile)
    ioStubs.readFile.mockImplementation(async (p: unknown) => {
      if (p === chapterFile) return chapterContent
      if (p === volumeFile) return volumeContent
      throw new Error(`unexpected read: ${String(p)}`)
    })
    ioStubs.searchWiki.mockResolvedValue([{ path: volumeFile }])
  }

  function resetStubs() {
    ioStubs.listSnapshots.mockReset()
    ioStubs.loadSnapshot.mockReset()
    ioStubs.findChapterFileByNumber.mockReset()
    ioStubs.fileExists.mockReset()
    ioStubs.readFile.mockReset()
    ioStubs.searchWiki.mockReset()
  }

  it("快照+正文+卷三源拼接：字数实算、大纲分离、卷分组", async () => {
    resetStubs()
    stubHappyPath()
    const data = await loadChapterDirectory("C:/proj")
    expect(data.outlines.map((r) => r.chapterNumber)).toEqual([-2])
    expect(data.volumes).toHaveLength(1)
    expect(data.volumes[0].meta?.volumeNumber).toBe(1)
    expect(data.volumes[0].rows[0]).toMatchObject({
      chapterNumber: 1,
      isOutline: false,
      title: "第1章 开端",
      wordCount: 100,
      filePath: chapterFile,
    })
  })

  it("快照缺失 + 正文富 H1 → 标题从正文解析（字数照算）", async () => {
    resetStubs()
    ioStubs.listSnapshots.mockResolvedValue([3])
    ioStubs.loadSnapshot.mockRejectedValue(new Error("snapshot missing"))
    ioStubs.findChapterFileByNumber.mockResolvedValue("C:/proj/chapters/chapter-003.md")
    ioStubs.fileExists.mockResolvedValue(true)
    ioStubs.readFile.mockResolvedValue("# 第3章 暗流\n正文正文")
    ioStubs.searchWiki.mockResolvedValue([])
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes[0].rows[0]).toMatchObject({
      chapterNumber: 3,
      title: "第3章 暗流",
      wordCount: 4,
    })
  })

  it("正文不可读（fileExists=false）→ 字数 null 且不读文件", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.fileExists.mockResolvedValue(false)
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes[0].rows[0].wordCount).toBeNull()
    expect(ioStubs.readFile).not.toHaveBeenCalledWith(chapterFile)
  })

  it("readFile 抛错 → 字数/内容置 null（标题仍取快照）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.readFile.mockImplementation(async (p: unknown) => {
      if (p === volumeFile) return volumeContent
      throw new Error("EACCES")
    })
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes[0].rows[0]).toMatchObject({ title: "第1章 开端", wordCount: null })
  })

  it("fileExists 抛错 → 同样进容错分支（字数 null）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.fileExists.mockRejectedValue(new Error("EACCES"))
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes[0].rows[0].wordCount).toBeNull()
  })

  it("findChapterFileByNumber 抛错 → filePath null（行不可点）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.findChapterFileByNumber.mockRejectedValue(new Error("index broken"))
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes).toHaveLength(1)
    expect(data.volumes[0].rows[0]).toMatchObject({ chapterNumber: 1, filePath: null, wordCount: null })
  })

  it("searchWiki 抛错 → 降级无卷分组（章节不丢失）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.searchWiki.mockRejectedValue(new Error("fts down"))
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes).toHaveLength(1)
    expect(data.volumes[0].meta).toBeNull()
    expect(data.volumes[0].rows.map((r) => r.chapterNumber)).toEqual([1])
  })

  it("卷文件读失败 → 该卷跳过（不影响其他卷）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.searchWiki.mockResolvedValue([{ path: volumeFile }, { path: "C:/proj/wiki/volume-002.md" }])
    ioStubs.readFile.mockImplementation(async (p: unknown) => {
      if (p === chapterFile) return chapterContent
      if (p === volumeFile) return volumeContent
      throw new Error("gone")
    })
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes).toHaveLength(1)
    expect(data.volumes[0].meta?.volumeNumber).toBe(1)
  })

  it("卷 frontmatter 无 volume_number → 非卷（章节入未分卷）", async () => {
    resetStubs()
    stubHappyPath()
    ioStubs.readFile.mockImplementation(async (p: unknown) => {
      if (p === chapterFile) return chapterContent
      return "---\ntitle: 散卷\n---\n正文"
    })
    const data = await loadChapterDirectory("C:/proj")
    expect(data.volumes).toHaveLength(1)
    expect(data.volumes[0].meta).toBeNull()
  })

  it("快照目录不可读 → 直接抛错（failLoud：不得伪装暂无章节）", async () => {
    resetStubs()
    ioStubs.listSnapshots.mockRejectedValue(new Error("目录不存在"))
    await expect(loadChapterDirectory("C:/proj")).rejects.toThrow("目录不存在")
  })

  it("多卷按卷号排序；无 frontmatter 卷视同非卷跳过", async () => {
    resetStubs()
    const ch12File = "C:/proj/chapters/chapter-012.md"
    const ch12Content = `# 第12章 远行\n${"旅途".repeat(25)}`
    const vol2 = "---\nvolume_number: 2\ntitle: 远行\nchapter_range_start: 11\nchapter_range_end: 20\n---\n"
    ioStubs.listSnapshots.mockResolvedValue([12, 1, -2])
    ioStubs.loadSnapshot.mockImplementation(async (_pp: unknown, n: unknown) => {
      if (n === 1) return { chapterTitle: "第1章 开端" }
      if (n === 12) return { chapterTitle: "第12章 远行" }
      throw new Error("snapshot missing")
    })
    ioStubs.findChapterFileByNumber.mockImplementation(async (_pp: unknown, n: unknown) =>
      n === 1 ? chapterFile : n === 12 ? ch12File : null,
    )
    ioStubs.fileExists.mockResolvedValue(true)
    ioStubs.readFile.mockImplementation(async (p: unknown) => {
      if (p === chapterFile) return chapterContent
      if (p === ch12File) return ch12Content
      if (p === "C:/proj/wiki/volume-002.md") return vol2
      if (p === volumeFile) return volumeContent
      return "随手记（无 frontmatter）"
    })
    ioStubs.searchWiki.mockResolvedValue([
      { path: "C:/proj/wiki/volume-002.md" },
      { path: volumeFile },
      { path: "C:/proj/wiki/note-plain.md" },
    ])
    const data = await loadChapterDirectory("C:/proj")
    // 卷号升序（排序比较器真实执行），纯文本卷跳过但章节保留
    expect(data.volumes.map((g) => g.meta?.volumeNumber ?? null)).toEqual([1, 2])
    expect(data.volumes[0].rows.map((r) => r.chapterNumber)).toEqual([1])
    expect(data.volumes[1].rows.map((r) => r.chapterNumber)).toEqual([12])
    expect(data.outlines.map((r) => r.chapterNumber)).toEqual([-2])
  })
})

describe("ChapterDirectory — 组件状态分支（增补）", () => {
  afterEach(cleanup)
  const mutableStore = storeState as unknown as Record<string, unknown>
  const savedProject = storeState.project
  const setSelectedFile = vi.mocked(storeState.setSelectedFile)

  // 每个用例后恢复共享 store 桩，避免污染原有用例。
  afterEach(() => {
    mutableStore.project = savedProject
    delete mutableStore.bumpDataVersion
    setSelectedFile.mockClear()
  })

  it("无项目 → 无项目态（不调装载器）", () => {
    mutableStore.project = null
    const loader = vi.fn(async () => ({ outlines: [], volumes: [] }) as ChapterDirectoryData)
    render(<ChapterDirectory loader={loader as ChapterDirectoryLoader} />)
    expect(screen.getByTestId("chapter-directory-no-project")).toBeTruthy()
    expect(loader).not.toHaveBeenCalled()
  })

  it("装载中 → 加载态", () => {
    render(<ChapterDirectory loader={() => new Promise<ChapterDirectoryData>(() => {})} />)
    expect(screen.getByTestId("chapter-directory-loading")).toBeTruthy()
  })

  it("装载抛错 → 错误态 + 重试透传 bumpDataVersion", async () => {
    const bump = vi.fn()
    mutableStore.bumpDataVersion = bump
    render(
      <ChapterDirectory
        loader={async () => {
          throw new Error("磁盘不可读")
        }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("chapter-directory-error")).toBeTruthy())
    expect(screen.getByTestId("chapter-directory-error").textContent).toContain("磁盘不可读")
    screen.getByTestId("chapter-directory-retry").click()
    expect(bump).toHaveBeenCalledTimes(1)
  })

  it("空数据（null / 空分组）→ 空态", async () => {
    const { unmount } = render(<ChapterDirectory loader={async () => null as unknown as ChapterDirectoryData} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-empty")).toBeTruthy())
    unmount()
    render(<ChapterDirectory loader={async () => ({ outlines: [], volumes: [] })} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-empty")).toBeTruthy())
  })

  it("行点击：有正文路径透传选择；无路径不透传；缺标题/字数显式 na；未分卷分组", async () => {
    const data: ChapterDirectoryData = {
      outlines: [{ chapterNumber: -1, isOutline: true, title: null, wordCount: null, filePath: null }],
      volumes: [
        {
          meta: null,
          rows: [
            { chapterNumber: 2, isOutline: false, title: "第2章 相逢", wordCount: 120, filePath: "C:/proj/2.md" },
            { chapterNumber: 3, isOutline: false, title: null, wordCount: null, filePath: null },
          ],
        },
      ],
    }
    render(<ChapterDirectory loader={async () => data} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-volume-ungrouped")).toBeTruthy())
    expect(screen.getByTestId("chapter-directory-outline-track")).toBeTruthy()
    expect(screen.getByTestId("chapter-directory-total").textContent).toBe("novel.chapterDirectory.total#3")
    // 缺标题/字数显式 na（非空白崩溃）
    expect(screen.getByTestId("chapter-directory-title-3").textContent).toBe("novel.chapterDirectory.na")
    expect(screen.getByTestId("chapter-directory-words-3").textContent).toBe("novel.chapterDirectory.na")
    // 有路径行点击透传
    screen.getByTestId("chapter-directory-row-2").click()
    expect(setSelectedFile).toHaveBeenCalledTimes(1)
    expect(setSelectedFile).toHaveBeenCalledWith("C:/proj/2.md")
    // 无路径行点击不透传（早退分支）
    screen.getByTestId("chapter-directory-row-3").click()
    expect(setSelectedFile).toHaveBeenCalledTimes(1)
  })

  it("卸载后装载解决 → 不写已卸载组件（取消分支）", async () => {
    let resolveLoader!: (v: ChapterDirectoryData) => void
    const loader = () =>
      new Promise<ChapterDirectoryData>((res) => {
        resolveLoader = res
      })
    const { unmount } = render(<ChapterDirectory loader={loader} />)
    unmount()
    await act(async () => {
      resolveLoader({ outlines: [], volumes: [] })
    })
  })

  it("卸载后装载拒绝 → 不写错误态（取消分支）", async () => {
    let rejectLoader!: (e: unknown) => void
    const loader = () =>
      new Promise<ChapterDirectoryData>((_res, rej) => {
        rejectLoader = rej
      })
    const { unmount } = render(<ChapterDirectory loader={loader} />)
    unmount()
    await act(async () => {
      rejectLoader(new Error("late failure"))
    })
  })
})
