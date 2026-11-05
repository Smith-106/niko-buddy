/**
 * 写入器注册表与校验测试（方案 d23eb1df P1）。
 *
 * 重点：catalog 的 `scope` 与写入器白名单必须互为镜像——一边改了另一边没改，
 * 要么出现「schema 说可写但写不了」，要么出现「能写但 schema 说只读」。
 */

import { describe, expect, it } from "vitest"

import { useWikiStore } from "@/stores/wiki-store"
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

/**
 * 写入器 read/write 真行为增补（覆盖率战役：lines 38-46/59-134）。
 * 直接用真实 useWikiStore（node 环境内存态，localStorage 不存在时守卫跳过），
 * 真实 project-store（node 下走 browserStore no-op 持久化），真实 applyTheme
 *（无 document 时直接返回）。不断言 toBeDefined，只断言写后状态与返回值。
 */
describe("写入器 read/write 真行为", () => {
  it("font-size-scale：write 落盘并经 store 钳制后返回实际值", async () => {
    const writer = getWriter("niko-buddy-ui-font-size-scale")!
    // 数字串经 asNumber 钳制路径
    const coerced = await writer.write("1.1" as unknown as number)
    expect(coerced).toBe(1.1)
    expect(useWikiStore.getState().uiFontSizeScale).toBe(1.1)
    // 越界值不拒绝——store 钳制到 1.3 后返回实际值（与 validateValue 的拒绝语义区分）
    const clamped = await writer.write(2)
    expect(clamped).toBe(1.3)
    expect(useWikiStore.getState().uiFontSizeScale).toBe(1.3)
    // read 读到内存态
    expect(writer.read()).toBe(1.3)
    await writer.write(1)
  })

  it("focus-mode：asBoolean 严格 === true，其余一律 false", async () => {
    const writer = getWriter("niko-buddy-focus-mode")!
    expect(await writer.write(true)).toBe(true)
    expect(writer.read()).toBe(true)
    // 非 true（字符串 "1" / 数字 1）全部归一为 false
    expect(await writer.write("1")).toBe(false)
    expect(await writer.write(1)).toBe(false)
    expect(useWikiStore.getState().focusMode).toBe(false)
  })

  it("chat-dock-position：bottom/right 互切；非字符串经 asString 透传", async () => {
    const writer = getWriter("niko-buddy-chat-dock-position")!
    expect(await writer.write("right")).toBe("right")
    expect(writer.read()).toBe("right")
    expect(await writer.write("bottom")).toBe("bottom")
    // asString 分支：数字被 String() 化后写入
    expect(await writer.write(123)).toBe("123")
    await writer.write("bottom")
  })

  it("offline-mode：布尔开关往返", async () => {
    const writer = getWriter("niko-buddy-offline-mode")!
    expect(await writer.write(true)).toBe(true)
    expect(writer.read()).toBe(true)
    expect(await writer.write(false)).toBe(false)
    expect(writer.read()).toBe(false)
  })

  it("theme：write 落盘 + store + applyTheme 全链路", async () => {
    const writer = getWriter("theme")!
    expect(await writer.write("dark")).toBe("dark")
    expect(writer.read()).toBe("dark")
    expect(useWikiStore.getState().theme).toBe("dark")
    await writer.write("system")
    expect(writer.read()).toBe("system")
  })

  it("defaultLlmModel / aiChatModel：字符串模型 id 往返", async () => {
    const def = getWriter("defaultLlmModel")!
    expect(await def.write("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(def.read()).toBe("claude-sonnet-4")
    const chat = getWriter("aiChatModel")!
    expect(await chat.write("gpt-5")).toBe("gpt-5")
    expect(chat.read()).toBe("gpt-5")
    // asString 分支：数字被 String() 化
    expect(await chat.write(7)).toBe("7")
    await def.write("")
    await chat.write("")
  })
})
