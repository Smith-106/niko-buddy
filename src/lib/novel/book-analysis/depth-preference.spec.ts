// @vitest-environment jsdom
/**
 * depth-preference 单元测试
 *
 * 覆盖：
 * - 读取：无记录 / 非法值 / 合法值
 * - 写入：合法值可写回 / 非法值静默忽略
 * - 不可用 localStorage：所有操作不抛错
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  loadDepthPreference,
  saveDepthPreference,
} from "./depth-preference"

describe("depth-preference", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  describe("loadDepthPreference", () => {
    it("无 window 环境（如 SSR/Node）时静默返回 null", () => {
      vi.stubGlobal("window", undefined)
      try {
        expect(loadDepthPreference()).toBeNull()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("无记录时返回 null", () => {
      expect(loadDepthPreference()).toBeNull()
    })

    it("读到合法值 fast 时返回 fast", () => {
      window.localStorage.setItem("qmai.book-analysis.depth-preference", "fast")
      expect(loadDepthPreference()).toBe("fast")
    })

    it("读到合法值 standard 时返回 standard", () => {
      window.localStorage.setItem("qmai.book-analysis.depth-preference", "standard")
      expect(loadDepthPreference()).toBe("standard")
    })

    it("读到合法值 deep 时返回 deep", () => {
      window.localStorage.setItem("qmai.book-analysis.depth-preference", "deep")
      expect(loadDepthPreference()).toBe("deep")
    })

    it("读到非法字符串时返回 null", () => {
      window.localStorage.setItem("qmai.book-analysis.depth-preference", "turbo")
      expect(loadDepthPreference()).toBeNull()
    })

    it("读到非合法字符串（如数字）时返回 null", () => {
      window.localStorage.setItem("qmai.book-analysis.depth-preference", "123")
      expect(loadDepthPreference()).toBeNull()
    })

    it("localStorage 抛错时返回 null，不向上抛", () => {
      const fake = {
        getItem: vi.fn(() => { throw new Error("quota exceeded") }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 0,
      }
      vi.stubGlobal("localStorage", fake)
      try {
        expect(loadDepthPreference()).toBeNull()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe("saveDepthPreference", () => {
    it("无 window 环境时静默忽略写入", () => {
      vi.stubGlobal("window", undefined)
      try {
        expect(() => saveDepthPreference("fast")).not.toThrow()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("写入 fast 后可读出 fast", () => {
      saveDepthPreference("fast")
      expect(window.localStorage.getItem("qmai.book-analysis.depth-preference")).toBe("fast")
    })

    it("写入 deep 后可读出 deep", () => {
      saveDepthPreference("deep")
      expect(window.localStorage.getItem("qmai.book-analysis.depth-preference")).toBe("deep")
    })

    it("写入非法值时不报错且不写入", () => {
      // @ts-expect-error 故意传非法值
      saveDepthPreference("turbo")
      expect(window.localStorage.getItem("qmai.book-analysis.depth-preference")).toBeNull()
    })

    it("localStorage 抛错时静默忽略", () => {
      const fake = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => { throw new Error("quota exceeded") }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 0,
      }
      vi.stubGlobal("localStorage", fake)
      try {
        expect(() => saveDepthPreference("standard")).not.toThrow()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
