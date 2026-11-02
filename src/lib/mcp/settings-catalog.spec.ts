/**
 * 设置目录 catalog 的机械校验（方案 d23eb1df P0）。
 *
 * 这个文件的存在理由：catalog 是**对外契约**。一旦漏登记一个键，后续
 * `settings.schema` 就会对外少报一项；一旦多登记一个不存在的键，外部 Agent
 * 会拿到一个永远读不到值的键。两种错都必须被测试挡住，不能靠人工核对。
 */

import { describe, expect, it } from "vitest"

import {
  CHAT_DOCK_POSITION_KEY,
  FOCUS_MODE_KEY,
  OFFLINE_MODE_KEY,
  UI_FONT_SIZE_SCALE_KEY,
} from "@/stores/wiki-store-config"

import {
  EXCLUDED_FALSE_POSITIVES,
  SECRET_REF_CATEGORIES,
  SETTINGS_BY_KEY,
  SETTINGS_CATALOG,
  isBridgeAllowedKey,
} from "./settings-catalog"

/** `wiki-store-config.ts` 导出的 4 个键常量——必须全部登记。 */
const EXPORTED_KEY_CONSTANTS = [
  CHAT_DOCK_POSITION_KEY,
  OFFLINE_MODE_KEY,
  UI_FONT_SIZE_SCALE_KEY,
  FOCUS_MODE_KEY,
]

/**
 * 散落在组件里的 `lk-*` 布局/图显示键。
 *
 * 它们不是从某个模块导出的常量（各自定义在使用处的文件内），因此无法 import，
 * 只能在这里显式列出。每个都已在代码里核实过确为 localStorage 键。
 */
const INLINE_LK_KEYS = [
  "lk-sidebar-collapsed",
  "lk-chat-height",
  "lk-chat-right-width",
  "lk-graph-label-display-mode",
  "lk-graph-edge-color",
  "lk-graph-edge-strength-v2",
  "lk-graph-edge-style",
  "lk-graph-edge-labels-always",
]

describe("settings catalog 覆盖性", () => {
  it("wiki-store-config.ts 导出的每个键常量都已登记", () => {
    const missing = EXPORTED_KEY_CONSTANTS.filter((key) => !SETTINGS_BY_KEY.has(key))
    expect(missing).toEqual([])
  })

  it("散落在组件里的 lk-* 键都已登记", () => {
    const missing = INLINE_LK_KEYS.filter((key) => !SETTINGS_BY_KEY.has(key))
    expect(missing).toEqual([])
  })

  it("没有登记任何已确认的假阳性", () => {
    const leaked = EXCLUDED_FALSE_POSITIVES.filter((key) => SETTINGS_BY_KEY.has(key))
    expect(leaked).toEqual([])
  })

  it("键名唯一", () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("索引与数组严格一致", () => {
    expect(SETTINGS_BY_KEY.size).toBe(SETTINGS_CATALOG.length)
    for (const entry of SETTINGS_CATALOG) {
      expect(SETTINGS_BY_KEY.get(entry.key)).toBe(entry)
    }
  })
})

describe("settings catalog 条目自洽", () => {
  it("P0 全部为只读", () => {
    expect(SETTINGS_CATALOG.every((e) => e.scope === "read")).toBe(true)
  })

  it("每项都有非空 label 与 verifiedAt", () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(entry.label.trim().length, `${entry.key} 缺 label`).toBeGreaterThan(0)
      expect(entry.verifiedAt.trim().length, `${entry.key} 缺 verifiedAt`).toBeGreaterThan(0)
    }
  })

  it("enum 项必须给 enumValues，非 enum 项不得给", () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.kind === "enum") {
        expect(entry.enumValues?.length, `${entry.key} 是 enum 但没给取值`).toBeGreaterThan(0)
        // 默认值必须在合法取值内，否则读取方拿到一个不可能出现的默认。
        expect(entry.enumValues).toContain(entry.defaultValue as string)
      } else {
        expect(entry.enumValues, `${entry.key} 不是 enum 却给了 enumValues`).toBeUndefined()
      }
    }
  })

  it("boolean 项的默认值是布尔而非字符串", () => {
    for (const entry of SETTINGS_CATALOG.filter((e) => e.kind === "boolean")) {
      expect(typeof entry.defaultValue, `${entry.key}`).toBe("boolean")
    }
  })

  it("number 项的默认值是数字", () => {
    for (const entry of SETTINGS_CATALOG.filter((e) => e.kind === "number")) {
      expect(typeof entry.defaultValue, `${entry.key}`).toBe("number")
    }
  })

  it("P0 只登记 localStorage（appState/secretRef 的键无固定 schema）", () => {
    expect(SETTINGS_CATALOG.every((e) => e.storage === "localStorage")).toBe(true)
  })
})

describe("secretRef 类别", () => {
  it("只登记类别，任何字段都不得承载明文值", () => {
    for (const category of SECRET_REF_CATEGORIES) {
      const fields = Object.keys(category)
      // 允许的字段就这两个：多一个字段就可能被塞进值。
      expect(fields.sort()).toEqual(["key", "label"])
      expect(category.label).not.toMatch(/^[A-Za-z0-9_-]{32,}$/)
    }
  })
})

describe("白名单判定", () => {
  it("精确匹配已登记键", () => {
    expect(isBridgeAllowedKey("niko-buddy-focus-mode")).toBe(true)
    expect(isBridgeAllowedKey("lk-graph-edge-style")).toBe(true)
  })

  it("不做前缀放行", () => {
    expect(isBridgeAllowedKey("niko-buddy-not-registered")).toBe(false)
    expect(isBridgeAllowedKey("lk-graph-edge")).toBe(false)
    expect(isBridgeAllowedKey("")).toBe(false)
  })
})
