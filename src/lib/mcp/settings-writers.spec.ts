/**
 * 写入器注册表与校验测试（方案 d23eb1df P1）。
 *
 * 重点：catalog 的 `scope` 与写入器白名单必须互为镜像——一边改了另一边没改，
 * 要么出现「schema 说可写但写不了」，要么出现「能写但 schema 说只读」。
 */

import { describe, expect, it } from "vitest"

import { SETTINGS_CATALOG, SETTINGS_BY_KEY } from "./settings-catalog"
import { SettingsValidationError, getWriter, validateValue } from "./settings-writers"

describe("写入器注册表", () => {
  it("每个 scope=write 的键都有写入器", () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.scope !== "write") continue
      expect(getWriter(entry.key), `${entry.key} 标了 write 但没有写入器`).not.toBeNull()
    }
  })

  it("scope=read 的键都没有写入器", () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.scope !== "read") continue
      expect(getWriter(entry.key), `${entry.key} 是只读键却注册了写入器`).toBeNull()
    }
  })

  it("未登记的键没有写入器", () => {
    expect(getWriter("niko-buddy-not-real")).toBeNull()
  })

  it("写入器同时具备 read 与 write（缺一不可）", () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.scope !== "write") continue
      const writer = getWriter(entry.key)
      expect(typeof writer?.read).toBe("function")
      expect(typeof writer?.write).toBe("function")
    }
  })
})

describe("validateValue", () => {
  const theme = SETTINGS_BY_KEY.get("theme")!
  const fontScale = SETTINGS_BY_KEY.get("niko-buddy-ui-font-size-scale")!
  const focusMode = SETTINGS_BY_KEY.get("niko-buddy-focus-mode")!

  it("枚举合法值通过", () => {
    expect(() => validateValue(theme, "dark")).not.toThrow()
  })

  it("枚举非法值抛 SettingsValidationError 并点出收到的值", () => {
    expect(() => validateValue(theme, "midnight")).toThrow(SettingsValidationError)
    expect(() => validateValue(theme, "midnight")).toThrow(/midnight/)
  })

  it("枚举不接受非字符串", () => {
    expect(() => validateValue(theme, 1)).toThrow(SettingsValidationError)
  })

  it("数字区间内通过，越界拒绝（不静默钳制）", () => {
    expect(() => validateValue(fontScale, 1)).not.toThrow()
    expect(() => validateValue(fontScale, 0.85)).not.toThrow()
    expect(() => validateValue(fontScale, 1.3)).not.toThrow()
    expect(() => validateValue(fontScale, 1.31)).toThrow(/不得大于/)
    expect(() => validateValue(fontScale, 0.84)).toThrow(/不得小于/)
  })

  it("数字拒绝 NaN / Infinity / 字符串", () => {
    expect(() => validateValue(fontScale, Number.NaN)).toThrow(SettingsValidationError)
    expect(() => validateValue(fontScale, Number.POSITIVE_INFINITY)).toThrow(SettingsValidationError)
    expect(() => validateValue(fontScale, "1.1")).toThrow(SettingsValidationError)
  })

  it("布尔只接受 true/false", () => {
    expect(() => validateValue(focusMode, true)).not.toThrow()
    expect(() => validateValue(focusMode, false)).not.toThrow()
    expect(() => validateValue(focusMode, "1")).toThrow(/布尔值/)
    expect(() => validateValue(focusMode, 1)).toThrow(/布尔值/)
  })

  it("json 键接受对象/数组或合法 JSON 字符串", () => {
    const nav = SETTINGS_BY_KEY.get("niko-buddy-nav-collapsed-groups")!
    expect(() => validateValue(nav, [])).not.toThrow()
    expect(() => validateValue(nav, ["a", "b"])).not.toThrow()
    expect(() => validateValue(nav, "[]")).not.toThrow()
    expect(() => validateValue(nav, "{oops")).toThrow(/JSON/)
    expect(() => validateValue(nav, 1)).toThrow(SettingsValidationError)
  })

  it("string 键拒绝非字符串", () => {
    const model = SETTINGS_BY_KEY.get("defaultLlmModel")!
    expect(() => validateValue(model, "claude-sonnet-4")).not.toThrow()
    expect(() => validateValue(model, 42)).toThrow(/字符串/)
  })
})
