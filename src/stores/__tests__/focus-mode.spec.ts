// @vitest-environment jsdom
/**
 * wiki-store 专注模式（focusMode）单元测试 — additive persisted 开关。
 * 覆盖：默认值 false、setter 读写 localStorage、readStoredFocusMode 各分支。
 */
import { describe, expect, it, beforeEach } from "vitest"

import { useWikiStore } from "../wiki-store"
import { FOCUS_MODE_KEY, readStoredFocusMode } from "../wiki-store-config"

beforeEach(() => {
  localStorage.clear()
  useWikiStore.setState({ focusMode: false })
})

describe("focusMode 专注模式开关", () => {
  it("默认关闭（保持现状，编辑区三栏布局不变）", () => {
    expect(useWikiStore.getState().focusMode).toBe(false)
  })

  it("setFocusMode(true) 更新 state 并持久化", () => {
    useWikiStore.getState().setFocusMode(true)
    expect(useWikiStore.getState().focusMode).toBe(true)
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe("1")
  })

  it("setFocusMode(false) 恢复默认并持久化", () => {
    useWikiStore.getState().setFocusMode(true)
    useWikiStore.getState().setFocusMode(false)
    expect(useWikiStore.getState().focusMode).toBe(false)
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe("0")
  })

  it("readStoredFocusMode 缺省/非法值回退 false", () => {
    expect(readStoredFocusMode()).toBe(false)
    localStorage.setItem(FOCUS_MODE_KEY, "yes")
    expect(readStoredFocusMode()).toBe(false)
    localStorage.setItem(FOCUS_MODE_KEY, "0")
    expect(readStoredFocusMode()).toBe(false)
  })

  it("readStoredFocusMode 仅认 \"1\"", () => {
    localStorage.setItem(FOCUS_MODE_KEY, "1")
    expect(readStoredFocusMode()).toBe(true)
  })
})
