// @vitest-environment jsdom
/**
 * useExemplarState — Style Exemplar 标记 / A/B 评分 hook 全口径覆盖。
 * 外部依赖（Rust 命令 / cognition 存储 / path-utils / window.getSelection）全部 mock。
 */
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExemplarState } from "./use-exemplar-state"
import type { StyleExemplarRecord } from "@/commands/exemplar"
import type { CognitionState } from "@/lib/novel"

const mocks = vi.hoisted(() => {
  const selected: { text: string | null } = { text: null }
  return {
    selected,
    markStyleExemplarViaRust: vi.fn(async () => {}),
    loadStyleExemplarsViaRust: vi.fn<(path: string) => Promise<StyleExemplarRecord[]>>(async () => []),
    deleteStyleExemplarViaRust: vi.fn(async () => {}),
    appendExemplarABSample: vi.fn(async () => {}),
    exemplarABStats: vi.fn<(state: CognitionState | null) => { enabledAvg: number | null; disabledAvg: number | null }>(() => ({ enabledAvg: null, disabledAvg: null })),
    loadCognitionState: vi.fn(async () => ({})),
    normalizePath: vi.fn((p: string) => p.replace(/\\/g, "/")),
    getFileName: vi.fn((p: string) => {
      const n = p.replace(/\\/g, "/")
      return n.split("/").pop() ?? p
    }),
    getSelection: vi.fn<() => Selection | null>(() => null),
  }
})

vi.mock("@/commands/exemplar", () => ({
  markStyleExemplarViaRust: mocks.markStyleExemplarViaRust,
  loadStyleExemplarsViaRust: mocks.loadStyleExemplarsViaRust,
  deleteStyleExemplarViaRust: mocks.deleteStyleExemplarViaRust,
}))

vi.mock("@/lib/novel/character-cognition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/character-cognition")>()
  return {
    ...actual,
      appendExemplarABSample: mocks.appendExemplarABSample,
      exemplarABStats: mocks.exemplarABStats,
      loadCognitionState: mocks.loadCognitionState,
    
  }
})

vi.mock("@/lib/path-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-utils")>()
  return {
    ...actual,
      normalizePath: mocks.normalizePath,
      getFileName: mocks.getFileName,
    
  }
})

const PROJECT = { path: "E:\\Novel\\proj" }
const NORMALIZED = "E:/Novel/proj"

describe("useExemplarState", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, "getSelection", {
      value: mocks.getSelection,
      configurable: true,
      writable: true,
    })
    mocks.getSelection.mockReturnValue(null)
    mocks.loadStyleExemplarsViaRust.mockResolvedValue([])
    mocks.deleteStyleExemplarViaRust.mockResolvedValue(undefined)
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: null })
    mocks.normalizePath.mockImplementation((p: string) => p.replace(/\\/g, "/"))
  })

  it("openExemplarDialogFromSelection 无项目时直接返回", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: null, selectedFile: null }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    expect(mocks.getSelection).not.toHaveBeenCalled()
    expect(mocks.loadStyleExemplarsViaRust).not.toHaveBeenCalled()
    expect(result.current.exemplarDialog.open).toBe(false)
  })

  it("选区为空时给出提示且不打开弹窗", async () => {
    mocks.getSelection.mockReturnValue({ toString: () => "   " } as unknown as Selection)
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    expect(result.current.exemplarFeedback).toBe("请先在消息中选中一段文本")
    expect(result.current.exemplarDialog.open).toBe(false)
    expect(mocks.loadStyleExemplarsViaRust).not.toHaveBeenCalled()
  })

  it("选中文本后打开弹窗并加载 exemplar 计数（selectedFile 提供 chapterId）", async () => {
    mocks.getSelection.mockReturnValue({ toString: () => " 选中的文字 " } as unknown as Selection)
    mocks.loadStyleExemplarsViaRust.mockResolvedValue([
      { exemplarId: "e1", chapterId: "ch1", text: "t1", markType: "style", createdAt: "2026-01-01T00:00:00.000Z" },
      { exemplarId: "e2", chapterId: "ch2", text: "t2", markType: "voice", createdAt: "2026-01-01T00:00:00.000Z" },
    ])
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: "src\\chapters\\ch1.md" }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    expect(result.current.exemplarDialog).toEqual({
      open: true,
      text: "选中的文字",
      chapterId: "ch1.md",
    })
    expect(result.current.exemplarMarkType).toBe("style")
    expect(result.current.exemplarNote).toBe("")
    expect(result.current.exemplarFeedback).toBe("")
    expect(result.current.exemplarCount).toBe(2)
    expect(mocks.loadStyleExemplarsViaRust).toHaveBeenCalledWith(NORMALIZED)
  })

  it("计数加载失败不阻塞标记流程（catch 分支）", async () => {
    mocks.getSelection.mockReturnValue({ toString: () => "text" } as unknown as Selection)
    mocks.loadStyleExemplarsViaRust.mockRejectedValue(new Error("io"))
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    expect(result.current.exemplarDialog.open).toBe(true)
    expect(result.current.exemplarDialog.chapterId).toBe("chat-selection")
    expect(result.current.exemplarCount).toBe(0)
  })

  it("submitExemplarMark 无项目时直接返回", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: null, selectedFile: null }),
    )
    await act(async () => {
      await result.current.submitExemplarMark()
    })
    expect(mocks.markStyleExemplarViaRust).not.toHaveBeenCalled()
  })

  it("submitExemplarMark 成功：note 有值时提交、计数刷新、弹窗关闭", async () => {
    mocks.loadStyleExemplarsViaRust.mockResolvedValue([
      { exemplarId: "e1", chapterId: "ch1", text: "t1", markType: "style", createdAt: "2026-01-01T00:00:00.000Z" },
    ])
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    // 打开后手动设置 dialog 内容与 note
    await act(async () => {
      result.current.setExemplarDialog({ open: true, text: "snippet", chapterId: "ch9" })
      result.current.setExemplarMarkType("voice")
      result.current.setExemplarNote("  补充说明  ")
    })
    await act(async () => {
      await result.current.submitExemplarMark()
    })
    expect(mocks.markStyleExemplarViaRust).toHaveBeenCalledWith(NORMALIZED, {
      chapterId: "ch9",
      text: "snippet",
      markType: "voice",
      note: "补充说明",
    })
    expect(result.current.exemplarCount).toBe(1)
    expect(result.current.exemplarFeedback).toBe("已标记为用户锚点（非自动生成）")
    expect(result.current.exemplarDialog).toEqual({ open: false, text: "", chapterId: "" })
  })

  it("submitExemplarMark 成功：note 为空时提交 undefined", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: "ch\\c.md" }),
    )
    await act(async () => {
      result.current.setExemplarDialog({ open: true, text: "t", chapterId: "c.md" })
      result.current.setExemplarNote("   ")
    })
    await act(async () => {
      await result.current.submitExemplarMark()
    })
    expect(mocks.markStyleExemplarViaRust).toHaveBeenCalledWith(NORMALIZED, {
      chapterId: "c.md",
      text: "t",
      markType: "style",
      note: undefined,
    })
    expect(result.current.exemplarFeedback).toBe("已标记为用户锚点（非自动生成）")
  })

  it("submitExemplarMark 失败：Error 实例显示 message", async () => {
    mocks.markStyleExemplarViaRust.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      result.current.setExemplarDialog({ open: true, text: "t", chapterId: "c" })
    })
    await act(async () => {
      await result.current.submitExemplarMark()
    })
    expect(result.current.exemplarFeedback).toBe("标记失败：boom")
    expect(result.current.exemplarDialog.open).toBe(true)
  })

  it("submitExemplarMark 失败：非 Error 异常转为 String", async () => {
    mocks.markStyleExemplarViaRust.mockRejectedValue("raw-string-error")
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      result.current.setExemplarDialog({ open: true, text: "t", chapterId: "c" })
    })
    await act(async () => {
      await result.current.submitExemplarMark()
    })
    expect(result.current.exemplarFeedback).toBe("标记失败：raw-string-error")
  })

  it("submitExemplarABScore 无项目时直接返回", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: null, selectedFile: null }),
    )
    await act(async () => {
      await result.current.submitExemplarABScore(5, "enabled")
    })
    expect(mocks.appendExemplarABSample).not.toHaveBeenCalled()
  })

  it("submitExemplarABScore 记录评分并显示均分（selectedFile 提供 chapterId，均分为数字）", async () => {
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: 4.5, disabledAvg: 3.25 })
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: "novel\\c2.md" }),
    )
    await act(async () => {
      await result.current.submitExemplarABScore(4, "enabled")
    })
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(NORMALIZED, {
      variant: "enabled",
      score: 4,
      chapterId: "c2.md",
      timestamp: expect.any(String),
    })
    expect(mocks.loadCognitionState).toHaveBeenCalledWith(NORMALIZED)
    expect(result.current.exemplarFeedback).toBe(
      "已记录评分 4★（开启）— 开启均分 4.50，关闭均分 3.25",
    )
  })

  it("submitExemplarABScore 无 selectedFile 时 chapterId 为 chat；均分为 null 时显示 N/A", async () => {
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: null })
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.submitExemplarABScore(5, "disabled")
    })
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      NORMALIZED,
      expect.objectContaining({ variant: "disabled", score: 5, chapterId: "chat" }),
    )
    expect(result.current.exemplarFeedback).toBe(
      "已记录评分 5★（关闭）— 开启均分 无，关闭均分 无",
    )
  })

  it("submitExemplarABScore 失败时走 formatError（缺省回退 toErrorMessage）", async () => {
    mocks.appendExemplarABSample.mockRejectedValue(new Error("ab-boom"))
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.submitExemplarABScore(3, "enabled")
    })
    expect(result.current.exemplarFeedback).toBe("ab-boom")
  })

  it("submitExemplarABScore 失败时优先使用 formatError", async () => {
    mocks.appendExemplarABSample.mockRejectedValue(new Error("ab-boom"))
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null, formatError: () => "fmt-fail" }),
    )
    await act(async () => {
      await result.current.submitExemplarABScore(3, "disabled")
    })
    expect(result.current.exemplarFeedback).toBe("fmt-fail")
  })

  it("打开弹窗时同步 exemplar 列表（标记前基线）", async () => {
    mocks.getSelection.mockReturnValue({ toString: () => "text" } as unknown as Selection)
    const records: StyleExemplarRecord[] = [
      { exemplarId: "e1", chapterId: "ch1", text: "t1", markType: "style", createdAt: "2026-01-01T00:00:00.000Z" },
    ]
    mocks.loadStyleExemplarsViaRust.mockResolvedValue(records)
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      await result.current.openExemplarDialogFromSelection()
    })
    expect(result.current.exemplarList).toEqual(records)
    expect(result.current.exemplarCount).toBe(1)
  })

  it("deleteExemplar 成功：删除 + 列表刷新 + 确认态复位", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      result.current.setExemplarDeleteConfirmId("e1")
      await result.current.deleteExemplar("e1-long-id-1234")
    })
    expect(mocks.deleteStyleExemplarViaRust).toHaveBeenCalledWith(NORMALIZED, "e1-long-id-1234")
    expect(result.current.exemplarFeedback).toBe("已删除范例 e1-long-")
    expect(result.current.exemplarDeleteConfirmId).toBeNull()
  })

  it("deleteExemplar 无项目时直接返回", async () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: null, selectedFile: null }),
    )
    await act(async () => {
      await result.current.deleteExemplar("e1")
    })
    expect(mocks.deleteStyleExemplarViaRust).not.toHaveBeenCalled()
  })

  it("deleteExemplar 失败：反馈错误且保留确认态", async () => {
    mocks.deleteStyleExemplarViaRust.mockRejectedValue(new Error("del-boom"))
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    await act(async () => {
      result.current.setExemplarDeleteConfirmId("e1")
    })
    await act(async () => {
      await result.current.deleteExemplar("e1")
    })
    expect(result.current.exemplarFeedback).toBe("删除失败：del-boom")
    expect(result.current.exemplarDeleteConfirmId).toBe("e1")
  })

  it("渲染初始状态：dialog 关闭、默认 markType style、计数 0", () => {
    const { result } = renderHook(() =>
      useExemplarState({ project: PROJECT, selectedFile: null }),
    )
    expect(result.current.exemplarDialog).toEqual({ open: false, text: "", chapterId: "" })
    expect(result.current.exemplarMarkType).toBe("style")
    expect(result.current.exemplarNote).toBe("")
    expect(result.current.exemplarCount).toBe(0)
    expect(result.current.exemplarFeedback).toBe("")
  })
})
