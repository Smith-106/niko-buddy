// @vitest-environment jsdom
/**
 * BookAnalysisSidebarPanel 测试
 * 验证整行点击选中作品 / 删除按钮 stopPropagation / 删时清理等关键交互。
 * 覆盖目标：s/l/b/f 全 100%（不可达分支单独记录）。
 */

import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { BookAnalysisTask } from "@/lib/novel/book-analysis/types"

const bookAnalysis = vi.hoisted(() => {
  const state = {
    setSelectedLibraryBookId: vi.fn<(bookId: string) => void>(),
    sidebarRefreshCounter: 0,
    triggerSidebarRefresh: vi.fn<() => void>(),
    tasks: [] as BookAnalysisTask[],
    cancelTask: vi.fn<(taskId: string) => void>(),
    requestReopenChapterSelection: vi.fn<(taskId: string) => void>(),
  }
  return { state }
})

const wiki = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    project: { id: "p1", name: "Novel", path: "/proj" },
    setActiveView: vi.fn(),
  }
  return { state }
})

const fsMock = vi.hoisted(() => ({
  listDirectory: vi.fn<(dir: string) => Promise<Array<{ name: string; is_dir: boolean; path: string }>>>(async () => []),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
  deleteFile: vi.fn(async () => {}),
}))

const cleanupMock = vi.hoisted(() => ({
  deleteOrphanAurasForBook: vi.fn(async () => 0),
}))

const auraLib = vi.hoisted(() => ({
  listCharacterAuras: vi.fn(async () => []),
}))

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

// === mocks 必须在 import 之前 ===
vi.mock("@/commands/fs", () => ({
  listDirectory: fsMock.listDirectory,
  readFile: fsMock.readFile,
  deleteFile: fsMock.deleteFile,
}))

vi.mock("@/lib/novel/book-analysis/aura-cleanup", () => ({
  deleteOrphanAurasForBook: cleanupMock.deleteOrphanAurasForBook,
}))

vi.mock("@/lib/novel/character-aura", () => ({
  listCharacterAuras: auraLib.listCharacterAuras,
}))

vi.mock("@/lib/toast", () => ({
  toast: toastMock,
}))

vi.mock("@/components/layout/panel-header-with-help", () => ({
  PanelHeaderWithHelp: ({ title }: { title: string }) => <span>{title}</span>,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: Record<string, unknown>) => unknown) => selector(wiki.state),
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: (selector?: (state: unknown) => unknown) =>
    selector ? selector(bookAnalysis.state) : bookAnalysis.state,
}))

import { BookAnalysisSidebarPanel } from "./book-analysis-sidebar-panel"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const METADATA = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: "测试书",
    totalChapters: 5,
    totalWords: 100,
    sourceType: "file",
    createdAt: 0,
    updatedAt: 1,
    ...over,
  })

function bookDirItem(name: string, path = `/proj/book-analysis/${name}`) {
  return { name, is_dir: true, path }
}

function plainItem(name: string, path = `/proj/book-analysis/${name}`) {
  return { name, is_dir: false, path }
}

function fileItem(name: string, path: string) {
  return { name, is_dir: false, path }
}

async function flushAsync(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function renderPanel(): { cleanup: () => void; rerender: () => void } {
  let root: ReturnType<typeof createRoot> | null = null
  const container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(<BookAnalysisSidebarPanel />)
  })
  return {
    rerender: () => {
      act(() => {
        root?.render(<BookAnalysisSidebarPanel />)
      })
    },
    cleanup: () => {
      act(() => root?.unmount())
      document.body.removeChild(container)
    },
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  bookAnalysis.state.tasks = []
  wiki.state.project = { id: "p1", name: "Novel", path: "/proj" }
  fsMock.listDirectory.mockResolvedValue([])
  fsMock.readFile.mockResolvedValue("")
  fsMock.deleteFile.mockResolvedValue(undefined)
  cleanupMock.deleteOrphanAurasForBook.mockResolvedValue(0)
  auraLib.listCharacterAuras.mockResolvedValue([])
  await flushAsync(20)
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("BookAnalysisSidebarPanel", () => {
  it("reopens character processing for a recognition-done running task", async () => {
    bookAnalysis.state.tasks = [{
      id: "task-recognition-done",
      projectPath: "/proj",
      bookId: "book-1",
      config: { sourceType: "file", sourcePath: "/books/a.txt", selectedChapters: [] },
      progress: {
        stage: "extracting_characters",
        stageLabel: "识别完成",
        completed: 100,
        total: 100,
        percentage: 100,
        recognitionStatus: "done",
        recognizedCharactersCount: 3,
      },
      status: "running",
      startedAt: 0,
      updatedAt: 0,
      chapters: [],
      characters: [],
      skills: [],
    }]
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const processButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("处理")) as HTMLButtonElement | undefined
    expect(processButton).toBeTruthy()

    await act(async () => {
      processButton?.click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(bookAnalysis.state.requestReopenChapterSelection).toHaveBeenCalledWith("task-recognition-done")
    cleanup()
    await flushAsync(20)
  })

  it("点击作品行触发 setSelectedLibraryBookId", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("book-analysis")) {
        return [bookDirItem("book-1")]
      }
      return []
    })
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("metadata.json")) return METADATA({ author: "甲" })
      return ""
    })

    const { cleanup } = renderPanel()
    await flushAsync(50)
    const allButtons = document.querySelectorAll("button")
    const bookBtn = allButtons[1] as HTMLButtonElement
    expect(bookBtn).toBeTruthy()
    await act(async () => {
      bookBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(50)
    expect(bookAnalysis.state.setSelectedLibraryBookId).toHaveBeenCalledWith("book-1")
    expect(wiki.state.setActiveView).toHaveBeenCalledWith("bookAnalysis")
    cleanup()
    await flushAsync(20)
  })

  it("点击删除按钮不触发整行 click，并调用 deleteFile", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("book-analysis")) return [bookDirItem("book-2")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA({ title: "书2" }))

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    fsMock.deleteFile.mockResolvedValue(undefined)

    const { cleanup } = renderPanel()
    await flushAsync(50)
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    expect(deleteBtn).toBeTruthy()
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(50)
    expect(fsMock.deleteFile).toHaveBeenCalledTimes(1)
    expect(bookAnalysis.state.setSelectedLibraryBookId).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("handles refresh without an open project", async () => {
    wiki.state.project = null
    const { cleanup } = renderPanel()
    await flushAsync(50)
    // 空态提示
    expect(document.body.textContent).toContain("还没有作品")
    // 刷新按钮 → loadBooks 直接 return（不抛错、不加载）
    const refreshBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.getAttribute("title") === "刷新列表") as HTMLButtonElement | undefined
    await act(async () => {
      refreshBtn?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fsMock.listDirectory).not.toHaveBeenCalled()
    cleanup()
    await flushAsync(20)
  })

  it("counts characters and skills, sorts by updatedAt, skips non-book entries", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) {
        return [bookDirItem("book-old"), plainItem("notes.txt"), bookDirItem("book-new")]
      }
      if (dir.endsWith("/book-old/characters")) {
        return [fileItem("a.json", dir), fileItem("b.json", dir), fileItem("c.txt", dir)]
      }
      if (dir.endsWith("/book-old/skills")) {
        return [fileItem("s1.md", dir), fileItem("s2.md", dir)]
      }
      if (dir.endsWith("/book-new/characters")) throw new Error("no characters dir")
      if (dir.endsWith("/book-new/skills")) throw new Error("no skills dir")
      return []
    })
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("/book-old/metadata.json")) return METADATA({ title: "旧书", updatedAt: 1 })
      if (p.endsWith("/book-new/metadata.json")) return METADATA({ title: "新书", updatedAt: 9 })
      return ""
    })
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const text = document.body.textContent ?? ""
    // 排序：新书在前
    expect(text.indexOf("新书")).toBeGreaterThan(-1)
    expect(text.indexOf("新书")).toBeLessThan(text.indexOf("旧书"))
    // 计数：旧书 2 角色 2 Skills
    expect(text).toContain("2 角色 · 2 Skills")
    // 新书目录缺失 → 0
    expect(text).toContain("0 角色 · 0 Skills")
    expect(text).toContain("已分析 2 部作品")
    cleanup()
    await flushAsync(20)
  })

  it("skips books whose metadata cannot be parsed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-ok"), bookDirItem("book-bad")]
      return []
    })
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("/book-ok/metadata.json")) return METADATA({ title: "好书" })
      return "not-json{{{"
    })
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(document.body.textContent).toContain("好书")
    expect(document.body.textContent).not.toContain("book-bad")
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("handles a missing book-analysis directory", async () => {
    fsMock.listDirectory.mockRejectedValueOnce(new Error("no dir"))
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(document.body.textContent).toContain("还没有作品")
    cleanup()
    await flushAsync(20)
  })

  it("shows aura counts for custom auras matching the book title", async () => {
    const builtInAura = {
      id: "b1", builtIn: true, name: "内置", category: "历史帝王", sourceNote: "n",
      corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
    }
    const matchingAura = {
      id: "c1", builtIn: false, name: "灵魂一", category: "拆书角色", sourceNote: "《测试书》相关整理",
      corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
    }
    const wrongCategoryAura = {
      id: "c2", builtIn: false, name: "灵魂二", category: "其他", sourceNote: "《测试书》相关",
      corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
    }
    const wrongNoteAura = {
      id: "c3", builtIn: false, name: "灵魂三", category: "拆书角色", sourceNote: "《别的书》相关",
      corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
    }
    const noNoteAura = {
      id: "c4", builtIn: false, name: "灵魂四", category: "拆书角色",
      corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
    }
    auraLib.listCharacterAuras.mockResolvedValue([builtInAura, matchingAura, wrongCategoryAura, wrongNoteAura, noNoteAura] as never)
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA({ title: "测试书" }))
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(document.body.textContent).toContain("已添加 1 个灵魂")
    cleanup()
    await flushAsync(20)
  })

  it("handles aura count failure silently", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    auraLib.listCharacterAuras.mockRejectedValueOnce(new Error("load failed"))
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA())
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(warnSpy).toHaveBeenCalled()
    // 作品列表仍正常显示
    expect(document.body.textContent).toContain("测试书")
    expect(document.body.textContent).not.toContain("已添加")
    warnSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("does not delete when the user cancels the confirm dialog", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA())
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(50)
    expect(fsMock.deleteFile).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("shows a toast when deleting without a project", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA())
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { rerender, cleanup } = renderPanel()
    await flushAsync(50)
    // 项目在列表加载后关闭
    wiki.state.project = null
    rerender()
    await flushAsync(50)
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(50)
    expect(fsMock.deleteFile).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith("当前没有打开任何项目，无法删除")
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("deletes a selected book and reports orphan aura cleanup", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA({ title: "测试书" }))
    cleanupMock.deleteOrphanAurasForBook.mockResolvedValue(2)
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { cleanup } = renderPanel()
    await flushAsync(50)
    // 先选中作品
    const bookBtn = document.querySelectorAll("button")[1] as HTMLButtonElement
    await act(async () => {
      bookBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(50)
    expect(bookAnalysis.state.setSelectedLibraryBookId).toHaveBeenCalledWith("book-1")
    // 删除
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(80)
    expect(fsMock.deleteFile).toHaveBeenCalledWith("/proj/book-analysis/book-1")
    expect(cleanupMock.deleteOrphanAurasForBook).toHaveBeenCalledWith("/proj", "测试书")
    // 选中的书被删除 → 本地选中清空
    expect(bookAnalysis.state.setSelectedLibraryBookId).toHaveBeenLastCalledWith(null)
    expect(bookAnalysis.state.triggerSidebarRefresh).toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith('已删除作品「测试书」，并清理了 2 个孤儿灵魂')
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("deletes a book even when orphan cleanup fails", async () => {
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA({ title: "测试书" }))
    cleanupMock.deleteOrphanAurasForBook.mockRejectedValue(new Error("cleanup failed"))
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(80)
    expect(toastMock.success).toHaveBeenCalledWith('已删除作品「测试书」')
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("reports delete failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    fsMock.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/book-analysis")) return [bookDirItem("book-1")]
      return []
    })
    fsMock.readFile.mockResolvedValue(METADATA())
    fsMock.deleteFile.mockRejectedValueOnce(new Error("disk error"))
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const deleteBtn = document.querySelector('[aria-label="删除作品"]') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushAsync(80)
    expect(errorSpy).toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith("删除作品失败，请稍后重试")
    errorSpy.mockRestore()
    confirmSpy.mockRestore()
    cleanup()
    await flushAsync(20)
  })

  it("renders running task progress with a stop button", async () => {
    bookAnalysis.state.tasks = [{
      id: "task-running",
      projectPath: "/proj",
      bookId: "book-1",
      config: { sourceType: "file", sourcePath: "/books/a.txt", selectedChapters: [] },
      progress: {
        stage: "extracting_characters",
        stageLabel: "处理中",
        completed: 42,
        total: 100,
        percentage: 42,
        recognitionStatus: "llm_recognizing",
        currentItem: "正在提取角色：林烬",
      },
      status: "running",
      startedAt: 0,
      updatedAt: 0,
      chapters: [],
      characters: [],
      skills: [],
    }]
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(document.body.textContent).toContain("处理中")
    expect(document.body.textContent).toContain("42%")
    expect(document.body.textContent).toContain("正在提取角色：林烬")
    const stopBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("停止")) as HTMLButtonElement | undefined
    expect(stopBtn).toBeTruthy()
    await act(async () => {
      stopBtn?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(bookAnalysis.state.cancelTask).toHaveBeenCalledWith("task-running")
    cleanup()
    await flushAsync(20)
  })

  it("renders running tasks with default labels and cancels non-running tasks from the section", async () => {
    bookAnalysis.state.tasks = [
      {
        id: "task-running-min",
        projectPath: "/proj",
        bookId: "book-1",
        config: { sourceType: "file", sourcePath: "/books/a.txt", selectedChapters: [] },
        progress: {
          stage: "extracting_characters",
          stageLabel: "",
          completed: 0,
          total: 10,
          recognitionStatus: "llm_recognizing",
          percentage: 0,
        },
        status: "running",
        startedAt: 0,
        updatedAt: 0,
        chapters: [],
        characters: [],
        skills: [],
      },
      {
        id: "task-completed",
        projectPath: "/proj",
        bookId: "book-1",
        config: { sourceType: "file", sourcePath: "/books/a.txt", selectedChapters: [] },
        progress: {
          stage: "completed",
          stageLabel: "完成",
          completed: 10,
          total: 10,
          percentage: 100,
          recognitionStatus: "done",
        },
        status: "completed",
        startedAt: 0,
        updatedAt: 0,
        chapters: [],
        characters: [],
        skills: [],
      },
    ]
    const { cleanup } = renderPanel()
    await flushAsync(50)
    const text = document.body.textContent ?? ""
    // stageLabel 为空 → 默认「处理中」；percentage 缺失 → 0%
    expect(text).toContain("处理中")
    expect(text).toContain("0%")
    // completed 任务不显示（既非 running 也非 recognition-done）
    expect(text).not.toContain("完成")
    cleanup()
    await flushAsync(20)
  })

  it("renders recognition-done tasks with the default stage label", async () => {
    bookAnalysis.state.tasks = [{
      id: "task-done-min",
      projectPath: "/proj",
      bookId: "book-1",
      config: { sourceType: "file", sourcePath: "/books/a.txt", selectedChapters: [] },
      progress: {
        stage: "extracting_characters",
        stageLabel: "",
        completed: 100,
        total: 100,
        percentage: 100,
        recognitionStatus: "done",
        recognizedCharactersCount: 2,
      },
      status: "running",
      startedAt: 0,
      updatedAt: 0,
      chapters: [],
      characters: [],
      skills: [],
    }]
    const { cleanup } = renderPanel()
    await flushAsync(50)
    expect(document.body.textContent).toContain("识别完成")
    // 「现在处理」按钮
    const processBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("现在处理")) as HTMLButtonElement | undefined
    expect(processBtn).toBeTruthy()
    await act(async () => {
      processBtn?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(bookAnalysis.state.requestReopenChapterSelection).toHaveBeenCalledWith("task-done-min")
    cleanup()
    await flushAsync(20)
  })
})
