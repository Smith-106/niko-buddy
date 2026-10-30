// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SETTINGS_DOMAIN_DRAFT_KEYS, SETTINGS_NAV_GROUPS, SETTINGS_SAVE_MODE } from "./settings-nav-config"
import { dirtySettingsDomains, mergeResyncedDraft, settingsValueEqual } from "./settings-view-helpers"
import { exceedsMax, parseClampedDecimal, parseClampedInt, parseClampedNumber } from "./settings-number-helpers"
import type { SettingsDraft } from "./settings-types"

describe("settings-nav-config", () => {
  it("每个分类在侧栏分组里恰好出现一次", () => {
    const listed = SETTINGS_NAV_GROUPS.flatMap((g) => [...g.categories])
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(Object.keys(SETTINGS_SAVE_MODE).sort())
  })

  it("三域的 draft 键互不重叠，且覆盖 SettingsDraft 全部字段", () => {
    const all = Object.values(SETTINGS_DOMAIN_DRAFT_KEYS).flat()
    expect(new Set(all).size).toBe(all.length)
    // 从 settings-types.ts 源码取接口字段名，防止新字段漏登记导致"未保存"提示失效
    const src = readFileSync(join(__dirname, "settings-types.ts"), "utf8")
    const body = src.slice(src.indexOf("export interface SettingsDraft"), src.indexOf("export type DraftSetter"))
    const fields = [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThan(40)
    expect([...all].sort()).toEqual([...fields].sort())
  })

  it("settings-view 中界面域/存储域/模型域的分类与 saveMode=draft 一致", () => {
    for (const [id, mode] of Object.entries(SETTINGS_SAVE_MODE)) {
      if (["llm", "rerank", "embedding", "network", "interface", "novel"].includes(id)) expect(mode, id).toBe("draft")
    }
  })
})

describe("settings-view-helpers", () => {
  const base = { a: 1, nested: { x: 1, y: [1, 2] }, s: "k" } as unknown as SettingsDraft

  it("settingsValueEqual 与键顺序无关，缺失键等同 undefined", () => {
    expect(settingsValueEqual({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true)
    expect(settingsValueEqual({ x: 1, z: undefined }, { x: 1 })).toBe(true)
    expect(settingsValueEqual([1, 2], [2, 1])).toBe(false)
    expect(settingsValueEqual({ x: [1] }, { x: [1, 2] })).toBe(false)
  })

  it("mergeResyncedDraft 未改字段取新基线，已改字段保留草稿", () => {
    const draft = { ...base, s: "user-edit" } as unknown as SettingsDraft
    const next = { ...base, a: 2, s: "store" } as unknown as SettingsDraft
    expect(mergeResyncedDraft(draft, base, next)).toEqual({ ...base, a: 2, s: "user-edit" })
  })

  it("mergeResyncedDraft adoptKeys：刚保存域里基线变了的字段采用新基线（规范化结果回到草稿）", () => {
    const draft = { ...base, s: "  url  ", a: 9 } as unknown as SettingsDraft
    const next = { ...base, s: "url" } as unknown as SettingsDraft
    const adopt = new Set(["s", "a"]) as unknown as ReadonlySet<keyof SettingsDraft>
    // s 基线变了 → 采用 "url"；a 基线没变 → 仍按合并规则保留草稿值 9
    expect(mergeResyncedDraft(draft, base, next, adopt)).toEqual({ ...base, s: "url", a: 9 })
    // 不在 adoptKeys 的字段不受影响
    expect(mergeResyncedDraft(draft, base, next)).toEqual({ ...base, s: "  url  ", a: 9 })
  })

  it("parseClampedNumber：空串/非数字为 null，整数四舍五入，小数保留，越界夹值", () => {
    expect(parseClampedInt("", 1, 10)).toBeNull()
    expect(parseClampedInt("abc", 1, 10)).toBeNull()
    expect(parseClampedInt("12", 3, 30)).toBe(12)
    expect(parseClampedInt("2.6", 1, 10)).toBe(3)
    expect(parseClampedInt("50", 3, 30)).toBe(30)
    expect(parseClampedDecimal("0.35", 0, 1)).toBe(0.35)
    expect(parseClampedDecimal("-1", 0, 1)).toBe(0)
    expect(parseClampedNumber(" 7 ", 0, 5, true)).toBe(5)
  })

  it("exceedsMax：低于下限不算（可能没输完），超过上限才算", () => {
    expect(exceedsMax("1", 30)).toBe(false)
    expect(exceedsMax("", 30)).toBe(false)
    expect(exceedsMax("30", 30)).toBe(false)
    expect(exceedsMax("31", 30)).toBe(true)
    expect(exceedsMax("0.6", 1)).toBe(false)
    expect(exceedsMax("1.2", 1)).toBe(true)
  })

  it("dirtySettingsDomains 只统计改过且与基线不同的键", () => {
    const b = { proxyUrl: "", uiLanguage: "zh", apiKey: "k" } as unknown as SettingsDraft
    const d = { proxyUrl: "x", uiLanguage: "zh", apiKey: "k2" } as unknown as SettingsDraft
    expect([...dirtySettingsDomains(d, b, new Set(["proxyUrl", "uiLanguage"]))]).toEqual(["storage"])
    expect([...dirtySettingsDomains(d, b, new Set(["apiKey"]))]).toEqual(["model"])
    expect(dirtySettingsDomains(b, b, new Set(["proxyUrl"])).size).toBe(0)
  })
})
