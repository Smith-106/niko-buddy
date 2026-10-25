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
