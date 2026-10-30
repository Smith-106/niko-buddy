// @vitest-environment jsdom
/**
 * useChatConfirmDialogs — Soul 注入确认与章节覆盖确认 resolver 的 hook 契约。
 * 覆盖：开合、确认/取消 Promise 决议、并发覆盖请求对前序 Promise 的取消兜底。
 */
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useChatConfirmDialogs } from "./use-chat-confirm-dialogs"

describe("useChatConfirmDialogs", () => {
  it("初始状态：两个弹窗均处于关闭状态", () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    expect(result.current.pendingSoulDialog).toEqual({ open: false, summary: "" })
    expect(result.current.pendingChapterOverwrite).toEqual({ open: false, chapterNumber: 0 })
  })

  it("requestSoulDialog 打开弹窗并返回待决议 Promise；closeSoulDialog(true) 决议为 true 并关闭", async () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    let promise: Promise<boolean> | undefined
    act(() => {
      promise = result.current.requestSoulDialog("人物性格变更摘要")
    })
    expect(result.current.pendingSoulDialog).toEqual({ open: true, summary: "人物性格变更摘要" })

    let resolvedValue: boolean | undefined
    void promise?.then((val) => {
      resolvedValue = val
    })

    await act(async () => {
      result.current.closeSoulDialog(true)
    })
    expect(resolvedValue).toBe(true)
    expect(result.current.pendingSoulDialog).toEqual({ open: false, summary: "" })
  })

  it("closeSoulDialog(false) 决议为 false", async () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    let promise: Promise<boolean> | undefined
    act(() => {
      promise = result.current.requestSoulDialog("foo")
    })
    let resolvedValue: boolean | undefined
    void promise?.then((val) => {
      resolvedValue = val
    })
    await act(async () => {
      result.current.closeSoulDialog(false)
    })
    expect(resolvedValue).toBe(false)
  })

  it("requestChapterOverwriteConfirm 打开弹窗并在 closeChapterOverwriteDialog(true) 时 resolve true", async () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    let promise: Promise<boolean> | undefined
    act(() => {
      promise = result.current.requestChapterOverwriteConfirm(12)
    })
    expect(result.current.pendingChapterOverwrite).toEqual({ open: true, chapterNumber: 12 })

    let resolvedValue: boolean | undefined
    void promise?.then((val) => {
      resolvedValue = val
    })
    await act(async () => {
      result.current.closeChapterOverwriteDialog(true)
    })
    expect(resolvedValue).toBe(true)
    expect(result.current.pendingChapterOverwrite).toEqual({ open: false, chapterNumber: 0 })
  })

  it("并发覆盖请求防御：前一个未决议请求被自动 resolve(false) 取消", async () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    let firstPromise: Promise<boolean> | undefined
    let secondPromise: Promise<boolean> | undefined
    act(() => {
      firstPromise = result.current.requestChapterOverwriteConfirm(1)
    })
    let firstResolved: boolean | undefined
    void firstPromise?.then((val) => {
      firstResolved = val
    })

    // 发起第二个请求，覆盖 resolver
    act(() => {
      secondPromise = result.current.requestChapterOverwriteConfirm(2)
    })
    // 第一个 Promise 应该已经被 resolve(false)
    await act(async () => {
      await Promise.resolve()
    })
    expect(firstResolved).toBe(false)
    expect(result.current.pendingChapterOverwrite).toEqual({ open: true, chapterNumber: 2 })

    let secondResolved: boolean | undefined
    void secondPromise?.then((val) => {
      secondResolved = val
    })
    await act(async () => {
      result.current.closeChapterOverwriteDialog(true)
    })
    expect(secondResolved).toBe(true)
  })

  it("在没有 pending 请求时调用 close 是安全的 no-op", () => {
    const { result } = renderHook(() => useChatConfirmDialogs())
    expect(() => {
      act(() => {
        result.current.closeSoulDialog(false)
        result.current.closeChapterOverwriteDialog(false)
      })
    }).not.toThrow()
    expect(result.current.pendingSoulDialog.open).toBe(false)
    expect(result.current.pendingChapterOverwrite.open).toBe(false)
  })
})
