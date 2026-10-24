// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ChapterDirectory, chapterDirectoryTitle, type ChapterDirectoryRow } from "./chapter-directory"

const storeState = vi.hoisted(() => ({
  project: { id: "p1", name: "proj", path: "C:/proj" } as { id: string; name: string; path: string } | null,
  dataVersion: 1,
  setSelectedFile: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts && typeof opts.count === "number" ? `${key}#${opts.count}` : key,
  }),
}))

function makeRows(): ChapterDirectoryRow[] {
  return [
    { chapterNumber: -1, isOutline: true, title: "卷一骨架", wordCount: null, filePath: null },
    { chapterNumber: 1, isOutline: false, title: "开端", wordCount: 3120, filePath: "C:/proj/第1章.md" },
    { chapterNumber: 2, isOutline: false, title: null, wordCount: null, filePath: null },
  ]
}

describe("chapterDirectoryTitle", () => {
  it("快照没有标题时用正文里的章名", () => {
    const body = "---\ntitle: \"第1章\"\n---\n\n# 第1章 夜航\n\n正文"
    expect(chapterDirectoryTitle(undefined, body, "C:/proj/第1章.md")).toBe("第1章 夜航")
  })

  it("快照已有章名时不改", () => {
    expect(chapterDirectoryTitle("第1章 旧题", "# 第1章 新题\n", null)).toBe("第1章 旧题")
  })

  it("正文和快照都没有章名时才空", () => {
    expect(chapterDirectoryTitle("", "正文没有标题", "C:/proj/001.md")).toBeNull()
  })
})

describe("ChapterDirectory", () => {
  beforeEach(() => {
    storeState.project = { id: "p1", name: "proj", path: "C:/proj" }
    storeState.dataVersion = 1
    storeState.setSelectedFile = vi.fn()
  })
  afterEach(cleanup)

  it("渲染行：章号/标题/字数，缺列为暂无标记", async () => {
    render(<ChapterDirectory loader={async () => makeRows()} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-row-2")).toBeTruthy())
    expect(screen.getByTestId("chapter-directory-title-1").textContent).toBe("开端")
    expect(screen.getByTestId("chapter-directory-words-1").textContent).toBe("3120")
    expect(screen.getByTestId("chapter-directory-title-2").textContent).toBe("novel.chapterDirectory.na")
    expect(screen.getByTestId("chapter-directory-words-2").textContent).toBe("novel.chapterDirectory.na")
    expect(screen.getByTestId("chapter-directory-total").textContent).toBe("novel.chapterDirectory.total#3")
  })

  it("无项目：显式空态，不返回 null", async () => {
    storeState.project = null
    const loader = vi.fn(async () => makeRows())
    const { container } = render(<ChapterDirectory loader={loader} />)
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId("chapter-directory-no-project").textContent).toBe("novel.chapterDirectory.noProject")
    expect(loader).not.toHaveBeenCalled()
  })

  it("装载失败：显式错误而非空列表", async () => {
    render(<ChapterDirectory loader={async () => { throw new Error("boom") }} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-error")).toBeTruthy())
    expect(screen.getByTestId("chapter-directory-error").textContent).toContain("boom")
  })

  it("空快照：诚实空态", async () => {
    render(<ChapterDirectory loader={async () => []} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-empty")).toBeTruthy())
  })

  it("点击有正文文件的行才打开正文", async () => {
    render(<ChapterDirectory loader={async () => makeRows()} />)
    await waitFor(() => expect(screen.getByTestId("chapter-directory-row-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("chapter-directory-row-2"))
    expect(storeState.setSelectedFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("chapter-directory-row-1"))
    expect(storeState.setSelectedFile).toHaveBeenCalledWith("C:/proj/第1章.md")
  })
})
